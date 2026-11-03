import { createHash } from 'node:crypto';
import { z } from 'zod';
import pLimit from 'p-limit';
import { TMDBMetadata } from '../metadata/tmdb.js';
import { Cache } from '../utils/cache.js';
import { parseRetryAfter } from '../utils/http.js';
import type { HistoryItem, MediaType, Title } from './ranking.js';

export interface HistoryProvider {
  history(type: MediaType): Promise<HistoryItem[]>;
}

const mediaIds = z.object({
  ids: z.object({ simkl: z.number(), imdb: z.string().nullish() }),
});
const itemIds = z.object({
  movie: mediaIds.optional(),
  show: mediaIds.optional(),
});
const historyResponse = z.array(
  itemIds.extend({
    status: z.string().optional(),
    last_watched_at: z.string().nullish(),
    user_rating: z.number().nullish(),
    total_plays_count: z.number().nullish(),
  })
);

export class SimklAuthorizationError extends Error {}

export class SimklRateLimit extends Error {
  constructor(readonly seconds: number) {
    super('Simkl rate limit');
  }
}

const activityBlock = z.record(z.string(), z.string().nullish()).optional();
const activitySchema = z.object({
  all: z.string().nullish(),
  movies: activityBlock,
  tv_shows: activityBlock,
});
type Activity = z.infer<typeof activitySchema>;
const historyCache = Cache.getInstance<
  string,
  {
    activity: Activity;
    entries: Map<number, HistoryItem>;
  }
>('recommendation_history', 400, 'memory');
const simklSyncs = new Map<string, Promise<HistoryItem[]>>();
const simklCooldown = Cache.getInstance<string, number>(
  'recommendation_simkl_cooldown',
  400,
  'memory'
);

export class SimklHistory implements HistoryProvider {
  constructor(
    private clientId: string,
    private accessToken: string,
    private scope: string
  ) {}

  private async get(path: string, query: Record<string, string> = {}) {
    const url = new URL(path, 'https://api.simkl.com');
    url.search = new URLSearchParams(query).toString();
    const response = await fetch(url, {
      headers: {
        'simkl-api-key': this.clientId,
        'User-Agent': 'AIOStreams',
        Authorization: 'Bearer ' + this.accessToken,
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (response.status === 429) {
      throw new SimklRateLimit(
        Math.min(
          3600,
          Math.max(
            1,
            parseRetryAfter(response.headers.get('retry-after')) ?? 60
          )
        )
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new SimklAuthorizationError('Simkl authorization failed');
    }
    if (!response.ok) throw new Error('Simkl history unavailable');
    return z
      .record(z.string(), z.unknown())
      .parse((await response.json()) ?? {});
  }

  async history(type: MediaType): Promise<HistoryItem[]> {
    const accountKey = createHash('sha256')
      .update(JSON.stringify([this.clientId, this.accessToken]))
      .digest('hex');
    const cacheKey = createHash('sha256')
      .update(JSON.stringify([this.scope, type, accountKey]))
      .digest('hex');
    // Simkl asks clients to fetch movie and show baselines serially.
    const waitFor = simklSyncs.get(accountKey)?.catch(() => undefined);
    const task = Promise.resolve(waitFor).then(async () => {
      const remaining = Math.ceil(
        (((await simklCooldown.get(accountKey)) ?? 0) - Date.now()) / 1000
      );
      if (remaining > 0) throw new SimklRateLimit(remaining);
      try {
        return await this.syncHistory(type, cacheKey);
      } catch (error) {
        if (error instanceof SimklRateLimit) {
          await simklCooldown.set(
            accountKey,
            Date.now() + error.seconds * 1000,
            error.seconds
          );
        } else if (error instanceof SimklAuthorizationError) {
          await historyCache.delete(cacheKey);
        }
        throw error;
      }
    });
    simklSyncs.set(accountKey, task);
    try {
      return await task;
    } finally {
      if (simklSyncs.get(accountKey) === task) simklSyncs.delete(accountKey);
    }
  }

  private async syncHistory(
    type: MediaType,
    cacheKey: string
  ): Promise<HistoryItem[]> {
    const key = type === 'movie' ? 'movies' : 'shows';
    const block = type === 'movie' ? 'movies' : 'tv_shows';
    const previous = await historyCache.get(cacheKey, true);
    const activity = activitySchema.parse(await this.get('/sync/activities'));
    if (previous && previous.activity.all === activity.all) {
      return [...previous.entries.values()];
    }

    const since = previous?.activity.all;
    const entries = new Map(previous?.entries);
    const changed = (field: string) =>
      previous?.activity[block]?.[field] !== activity[block]?.[field];
    const merge = (body: Record<string, unknown>) => {
      for (const entry of historyResponse.parse(body[key] ?? [])) {
        const ids = (entry.movie ?? entry.show)?.ids;
        if (!ids) continue;
        const watchedAt = Date.parse(entry.last_watched_at ?? '');
        if (
          !ids.imdb ||
          !/^tt\d+$/.test(ids.imdb) ||
          (!Number.isFinite(watchedAt) &&
            entry.status !== 'completed' &&
            !entry.user_rating)
        ) {
          entries.delete(ids.simkl);
          continue;
        }
        entries.set(ids.simkl, {
          imdb: ids.imdb,
          rating: entry.user_rating ?? undefined,
          watchedAt: Number.isFinite(watchedAt) ? watchedAt : undefined,
          plays:
            type === 'movie' ? Math.max(1, entry.total_plays_count ?? 1) : 1,
        });
      }
    };

    if (!since) {
      entries.clear();
      merge(await this.get('/sync/all-items/' + key));
    } else {
      const query = { date_from: since };
      if (
        [
          'watching',
          'plantowatch',
          'hold',
          'completed',
          'dropped',
          'notinteresting',
        ].some(changed)
      ) {
        merge(await this.get('/sync/all-items/' + key, query));
      }
      if (changed('rated_at'))
        merge(await this.get('/sync/ratings/' + key, query));
      if (changed('removed_from_list')) {
        const body = await this.get('/sync/all-items/' + key, {
          extended: 'simkl_ids_only',
        });
        const current = new Set(
          z
            .array(itemIds)
            .parse(body[key] ?? [])
            .map((entry) => (entry.movie ?? entry.show)?.ids.simkl)
        );
        for (const id of entries.keys()) {
          if (!current.has(id)) entries.delete(id);
        }
      }
    }
    await historyCache.set(cacheKey, { activity, entries }, 14 * 86400);
    return [...entries.values()];
  }
}

const rawTitle = z.object({
  id: z.number(),
  adult: z.boolean().optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  release_date: z.string().nullish(),
  first_air_date: z.string().nullish(),
  original_language: z.string().optional(),
  runtime: z.number().nullish(),
  episode_run_time: z.array(z.number()).optional(),
  genres: z.array(z.object({ id: z.number() })).optional(),
  genre_ids: z.array(z.number()).optional(),
  production_countries: z
    .array(z.object({ iso_3166_1: z.string() }))
    .optional(),
  origin_country: z.array(z.string()).optional(),
  keywords: z
    .object({
      keywords: z.array(z.object({ id: z.number() })).optional(),
      results: z.array(z.object({ id: z.number() })).optional(),
    })
    .optional(),
  credits: z
    .object({
      cast: z.array(z.object({ id: z.number() })).optional(),
      crew: z.array(z.object({ id: z.number(), job: z.string() })).optional(),
    })
    .optional(),
  created_by: z.array(z.object({ id: z.number() })).optional(),
  imdb_id: z.string().nullish(),
  external_ids: z.object({ imdb_id: z.string().nullish() }).optional(),
  vote_average: z.number().optional(),
  vote_count: z.number().optional(),
  popularity: z.number().optional(),
});

function title(raw: z.infer<typeof rawTitle>): Title {
  const year = Number((raw.release_date || raw.first_air_date)?.slice(0, 4));
  return {
    id: raw.id,
    adult: raw.adult,
    imdb: raw.imdb_id || raw.external_ids?.imdb_id || undefined,
    name: raw.title || raw.name || '',
    description: raw.overview ?? undefined,
    poster: raw.poster_path
      ? 'https://image.tmdb.org/t/p/w500' + raw.poster_path
      : undefined,
    year: year || undefined,
    genres: (raw.genre_ids ?? raw.genres?.map(({ id }) => id) ?? []).map(
      String
    ),
    keywords: (raw.keywords?.keywords ?? raw.keywords?.results ?? []).map(
      ({ id }) => String(id)
    ),
    cast: (raw.credits?.cast ?? []).slice(0, 10).map(({ id }) => String(id)),
    directors: [
      ...new Set(
        [
          ...(raw.created_by ?? []),
          ...(raw.credits?.crew ?? []).filter(({ job }) => job === 'Director'),
        ].map(({ id }) => String(id))
      ),
    ],
    countries:
      raw.production_countries?.map(({ iso_3166_1 }) => iso_3166_1) ??
      raw.origin_country ??
      [],
    language: raw.original_language,
    runtime: raw.runtime ?? raw.episode_run_time?.[0],
    rating: raw.vote_average ?? 0,
    votes: raw.vote_count ?? 0,
    popularity: raw.popularity ?? 0,
  };
}

const cache = Cache.getInstance<string, unknown>(
  'recommendation_tmdb',
  10000,
  'memory'
);
const ttl = 86400;
const limitTmdb = pLimit(12);

export class RecommendationTmdb extends TMDBMetadata {
  private async request(path: string, params: Record<string, string> = {}) {
    return cache.wrap(
      () =>
        limitTmdb(async () => (await this.getJson(path, params, true)) ?? null),
      path + '?' + new URLSearchParams(params),
      ttl
    );
  }

  async find(imdb: string, type: MediaType): Promise<number | undefined> {
    const data = await this.request('/find/' + imdb, {
      external_source: 'imdb_id',
    });
    const result = z
      .object({
        movie_results: z.array(z.object({ id: z.number() })),
        tv_results: z.array(z.object({ id: z.number() })),
      })
      .nullable()
      .parse(data);
    return (type === 'movie' ? result?.movie_results : result?.tv_results)?.[0]
      ?.id;
  }

  async details(id: number, type: MediaType): Promise<Title | undefined> {
    const media = type === 'movie' ? 'movie' : 'tv';
    const data = await this.request('/' + media + '/' + id, {
      append_to_response: 'credits,keywords,external_ids',
    });
    return data ? title(rawTitle.parse(data)) : undefined;
  }

  async candidates(
    type: MediaType,
    params: Record<string, string>,
    seed?: number,
    related: 'recommendations' | 'similar' = 'recommendations'
  ): Promise<Title[]> {
    const media = type === 'movie' ? 'movie' : 'tv';
    const data = await this.request(
      seed ? '/' + media + '/' + seed + '/' + related : '/discover/' + media,
      params
    );
    return data
      ? z
          .object({ results: z.array(rawTitle) })
          .parse(data)
          .results.map(title)
      : [];
  }
}
