import { Cache } from '../../utils/cache.js';
import { z } from 'zod';
import { bootstrap } from '../../config/bootstrap.js';
import type { SinkRow } from '../../db/repositories/playback-handoff.js';
import { SimklConnection } from '../../recommendations/simkl-connection.js';
import { readBodyCapped } from '../../utils/safe-fetch.js';
import { config } from '../../config/index.js';
import { PLAYBACK_EVENTS } from './capability.js';
import type { PlaybackStatePayload } from './pull.js';
import type { ResolvedPlaybackSink } from './resolve.js';

const baseUrl = 'builtin-simkl://tracker';

export async function builtinSimklSink(
  uuid: string,
  variant: string
): Promise<ResolvedPlaybackSink | undefined> {
  const grant = await SimklConnection.trackerGrant(uuid, variant);
  if (!grant) return;
  return {
    instanceId: 'builtin-simkl-' + grant,
    name: 'Built-in Simkl',
    baseUrl,
    query: '?' + new URLSearchParams({ variant, grant }),
    events: PLAYBACK_EVENTS,
    types: ['movie', 'series', 'anime'],
    bulk: true,
    pullable: true,
  };
}

export function isBuiltinSimkl(sink: SinkRow) {
  return (
    sink.baseUrl === baseUrl &&
    sink.addonInstanceId.startsWith('builtin-simkl-')
  );
}

async function authorization(sink: SinkRow) {
  const query = new URLSearchParams(sink.query);
  const variant = query.get('variant');
  const grant = query.get('grant');
  if (variant === null || !grant || !bootstrap.simklClientId) return;
  if (!(await SimklConnection.trackerGrant(sink.uuid, variant, grant))) return;
  const token = await SimklConnection.accessToken(sink.uuid, variant, grant);
  if (
    !token ||
    !(await SimklConnection.trackerGrant(sink.uuid, variant, grant))
  )
    return;
  return {
    Authorization: 'Bearer ' + token,
    'simkl-api-key': bootstrap.simklClientId,
    'Content-Type': 'application/json',
    'User-Agent': 'AIOStreams',
  };
}

function request(
  headers: Record<string, string>,
  path: string,
  body?: unknown,
  deadline?: AbortSignal
) {
  return fetch('https://api.simkl.com' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: deadline
      ? AbortSignal.any([deadline, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
}

const episodeNumber = z.number().int().nonnegative();
const episodeRef = z.object({
  season: episodeNumber,
  episode: episodeNumber,
});
const eventSchema = z.object({
  event: z.enum(PLAYBACK_EVENTS),
  scope: z.enum(['movie', 'episode', 'season', 'series']).optional(),
  at: z.number(),
  ids: z.record(z.string(), z.string()).optional(),
  season: episodeNumber.nullish(),
  episode: episodeNumber.nullish(),
  durationMs: z.number().positive().optional(),
  positionMs: z.number().nonnegative().optional(),
  played: z.boolean().optional(),
  videos: z.array(episodeRef).optional(),
});

export async function pushBuiltinSimkl(
  sink: SinkRow,
  body: string
): Promise<Response> {
  const parsed = eventSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return new Response(null, { status: 204 });
  const event = parsed.data;
  // Prefer show-level IDs with Jellyfin's season and episode numbering.
  const ids = Object.fromEntries(
    Object.entries(event.ids ?? {})
      .filter(([key, value]) =>
        key === 'imdb'
          ? /^tt\d+$/.test(value)
          : ['tmdb', 'tvdb', 'simkl'].includes(key) && /^\d+$/.test(value)
      )
      .map(([key, value]) => [key, key === 'imdb' ? value : Number(value)])
  );
  if (!Object.keys(ids).length) return new Response(null, { status: 204 });
  const movie = event.scope === 'movie';
  const episode = episodeRef.safeParse(event);
  const headers = await authorization(sink);
  if (!headers) return new Response(null, { status: 401 });
  if (event.event === 'played' || event.event === 'unplayed') {
    const episodes = event.videos ?? (episode.success ? [episode.data] : []);
    if (!movie && !episodes.length) return new Response(null, { status: 204 });
    const watched_at =
      event.event === 'played'
        ? new Date(event.at * 1000).toISOString()
        : undefined;
    const seasons = new Map<
      number,
      { number: number; watched_at?: string }[]
    >();
    for (const ref of episodes) {
      const entries = seasons.get(ref.season) ?? [];
      entries.push({ number: ref.episode, watched_at });
      seasons.set(ref.season, entries);
    }
    return request(
      headers,
      event.event === 'played' ? '/sync/history' : '/sync/history/remove',
      movie
        ? { movies: [{ ids, watched_at }] }
        : {
            shows: [
              {
                ids,
                use_tvdb_anime_seasons: Boolean(ids.tvdb),
                seasons: [...seasons].map(([number, episodes]) => ({
                  number,
                  episodes,
                })),
              },
            ],
          }
    );
  }
  if (
    (!movie && !episode.success) ||
    event.durationMs === undefined ||
    event.positionMs === undefined
  )
    return new Response(null, { status: 204 });
  let progress = Math.min(
    100,
    Math.round((event.positionMs / event.durationMs) * 10000) / 100
  );
  if (event.event === 'stop' && event.played !== undefined) {
    progress = event.played
      ? Math.max(80, progress)
      : Math.min(79.99, progress);
  }
  const response = await request(
    headers,
    '/scrobble/' + event.event,
    movie
      ? { movie: { ids }, progress }
      : {
          show: { ids },
          episode: { season: event.season, number: event.episode },
          progress,
        }
  );
  if (response.status === 409) return new Response(null, { status: 204 });
  if (response.status === 400) {
    const message = await response.text();
    if (/rate_limit/i.test(message)) {
      return new Response(null, {
        status: 429,
        headers: { 'Retry-After': '20' },
      });
    }
  }
  return response;
}

const media = z.object({
  ids: z.object({
    simkl: z.number().int().positive().nullish(),
    imdb: z.string().nullish(),
    tmdb: z.union([z.number(), z.string()]).nullish(),
    tvdb: z.union([z.number(), z.string()]).nullish(),
  }),
  runtime: z.number().positive().nullish(),
});
const episode = z.object({
  season: episodeNumber.optional(),
  number: episodeNumber,
  tvdb_season: episodeNumber.nullish(),
  tvdb_number: episodeNumber.nullish(),
  tvdb: z.object({ season: episodeNumber, episode: episodeNumber }).nullish(),
  runtime: z.number().positive().nullish(),
});
const entry = z.object({
  movie: media.nullish(),
  show: media.nullish(),
  anime: media.nullish(),
});
const playbacks = z.array(
  entry.extend({
    episode: episode.nullish(),
    progress: z.number().min(0).max(100),
    paused_at: z.string(),
    runtime: z.number().positive().nullish(),
  })
);
const history = z.array(
  entry.extend({
    anime_type: z.string().nullish(),
    last_watched_at: z.string().nullish(),
    seasons: z
      .array(
        z.object({
          number: episodeNumber,
          episodes: z.array(episode),
        })
      )
      .nullish(),
  })
);

function metaId(item: z.infer<typeof entry>) {
  const ids = (item.movie ?? item.show ?? item.anime)?.ids;
  if (ids?.imdb && /^tt\d+$/.test(ids.imdb)) return ids.imdb;
  if (ids?.tmdb && /^\d+$/.test(String(ids.tmdb))) return 'tmdb:' + ids.tmdb;
  if (!item.movie && ids?.tvdb && /^\d+$/.test(String(ids.tvdb)))
    return 'tvdb:' + ids.tvdb;
}

async function json(
  headers: Record<string, string>,
  path: string,
  deadline: AbortSignal
) {
  const response = await request(headers, path, undefined, deadline);
  if (!response.ok) throw new Error('Simkl HTTP ' + response.status);
  const body = await readBodyCapped(
    response,
    config.watchState.pullMaxResponseBytes
  );
  return JSON.parse(body.toString('utf8')) as unknown;
}

const runtimes = Cache.getInstance<string, number>(
  'builtin-simkl-runtime',
  1000,
  'memory'
);

async function playbackRuntime(
  headers: Record<string, string>,
  item: z.infer<typeof entry>,
  deadline: AbortSignal
) {
  const media = item.movie ?? item.show ?? item.anime;
  if (media?.runtime) return media.runtime;
  if (!media?.ids.simkl) return;
  const path =
    (item.movie ? '/movies/' : item.show ? '/tv/' : '/anime/') +
    media.ids.simkl;
  const cached = await runtimes.get(path);
  if (cached !== undefined) return cached;
  // This is public metadata, even though the playback that references it is private.
  const publicHeaders = {
    'simkl-api-key': headers['simkl-api-key'],
    'User-Agent': 'AIOStreams',
  };
  const response = await request(publicHeaders, path, undefined, deadline);
  if (response.status === 404) return;
  if (!response.ok) throw new Error('Simkl HTTP ' + response.status);
  const body: unknown = await response.json();
  const parsed = z
    .object({ runtime: z.number().positive().nullish() })
    .parse(Array.isArray(body) && !body.length ? {} : body);
  await runtimes.set(path, parsed.runtime ?? 0, 86_400);
  return parsed.runtime;
}

export async function pullBuiltinSimkl(
  sink: SinkRow
): Promise<PlaybackStatePayload> {
  const headers = await authorization(sink);
  if (!headers) throw new Error('Simkl HTTP 401');
  const deadline = AbortSignal.timeout(55_000);
  const activity = z
    .object({
      movies: z.record(z.string(), z.string().nullish()).nullish(),
      tv_shows: z.record(z.string(), z.string().nullish()).nullish(),
      anime: z.record(z.string(), z.string().nullish()).nullish(),
    })
    .parse(await json(headers, '/sync/activities', deadline));
  const version = JSON.stringify(
    [activity.movies, activity.tv_shows, activity.anime].map((bucket) =>
      [
        'completed',
        'watching',
        'hold',
        'dropped',
        'plantowatch',
        'removed_from_list',
      ].map((key) => bucket?.[key] ?? null)
    )
  );
  const rawPlayback = playbacks.parse(
    await json(headers, '/sync/playback', deadline)
  );
  if (rawPlayback.length > config.watchState.pullMaxItems)
    throw new Error('Simkl playback list exceeds the configured import limit');
  const items: NonNullable<PlaybackStatePayload['items']> = [];
  for (const item of rawPlayback) {
    const id = metaId(item);
    const at = Date.parse(item.paused_at);
    if (!id || !Number.isFinite(at)) continue;
    const season = item.episode?.tvdb_season ?? item.episode?.season;
    const number = item.episode?.tvdb_number ?? item.episode?.number;
    if (!item.movie && (season == null || number == null)) continue;
    const runtime =
      item.episode?.runtime ??
      item.runtime ??
      (await playbackRuntime(headers, item, deadline));
    if (!runtime) continue;
    items.push({
      type: item.movie ? 'movie' : 'series',
      metaId: id,
      videoId: item.movie ? id : [id, season, number].join(':'),
      season,
      episode: number,
      at,
      progressPercent: item.progress,
      durationMs: runtime * 60_000,
    });
  }
  if (version === sink.pullVersion) return { items, version };
  const movies = new Set<string>();
  const episodes = new Set<string>();
  for (const [kind, query] of [
    ['movies', 'extended=full'],
    ['shows', 'extended=full&include_all_episodes=yes'],
    ['anime', 'extended=full_anime_seasons&include_all_episodes=yes'],
  ] as const) {
    const raw = z
      .object({
        movies: history.optional(),
        shows: history.optional(),
        anime: history.optional(),
      })
      .parse(
        await json(headers, '/sync/all-items/' + kind + '?' + query, deadline)
      );
    for (const item of raw[kind] ?? []) {
      const id = metaId(item);
      if (!id) continue;
      if ((item.movie || item.anime_type === 'movie') && item.last_watched_at)
        movies.add(id);
      for (const season of item.seasons ?? []) {
        for (const ep of season.episodes) {
          episodes.add(
            [
              id,
              ep.tvdb?.season ?? ep.tvdb_season ?? season.number,
              ep.tvdb?.episode ?? ep.tvdb_number ?? ep.number,
            ].join(':')
          );
        }
      }
    }
  }
  return {
    items,
    version,
    watched: { movies: [...movies], episodes: [...episodes] },
  };
}
