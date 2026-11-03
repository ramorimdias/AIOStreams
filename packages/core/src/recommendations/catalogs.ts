import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { Manifest, MetaPreview, UserData } from '../db/schemas.js';
import { Cache } from '../utils/cache.js';
import { userScopeKey } from '../utils/user-scope.js';
import {
  buildProfile,
  discovery,
  diversify,
  rank,
  type Feature,
  type MediaType,
  type Profile,
  type Title,
} from './ranking.js';
import {
  RecommendationTmdb,
  SimklAuthorizationError,
  SimklHistory,
  SimklRateLimit,
} from './sources.js';

import { bootstrap } from '../config/bootstrap.js';
import { SimklConnection } from './simkl-connection.js';
import { applyVariants } from '../variants/runtime.js';

import {
  genreRows,
  themeRows,
  recommendationRows as rows,
  recommendationRowIds as rowIds,
  recommendationSourceId,
  type RecommendationRow as Row,
} from './rows.js';
export { recommendationSource, isRecommendationCatalog } from './rows.js';
const types: MediaType[] = ['movie', 'series'];
type Settings = NonNullable<UserData['personalizedRecommendations']>;
type Snapshot = {
  checkedAt: number;
  generatedAt: number;
  rotation?: number;
  fingerprint: string;
  rows: Record<Row, MetaPreview[]>;
  names?: Partial<Record<Row, string>>;
};
const snapshots = Cache.getInstance<string, Snapshot>(
  'personalized_recommendations',
  400,
  'memory'
);
const pending = new Map<string, Promise<Snapshot | undefined>>();
const retryAfter = Cache.getInstance<string, boolean>(
  'personalized_recommendations_backoff',
  400,
  'memory'
);
const limit = 24;
const regularRows = rowIds.filter((id) => id !== 'anime-top');
const animeRows: Row[] = ['anime-top'];
const namedRows: ReadonlySet<Row> = new Set([...genreRows, ...themeRows]);

export function simklVariant(user: UserData) {
  const variants = user.activeVariants?.length
    ? user.activeVariants
    : user.autoVariants;
  return variants?.at(-1) ?? '';
}

function catalogEnabled(
  user: UserData,
  source: string,
  type: string,
  row: Row
) {
  return (
    user.catalogModifications?.find(
      (item) => item.id === source + '.' + row && item.type === type
    )?.enabled ?? row !== 'anime-top'
  );
}

export async function recommendationManifest(
  user: UserData,
  preview = false
): Promise<Manifest | undefined> {
  if (!user.personalizedRecommendations?.enabled || !user.uuid) return;
  const variant = simklVariant(user);
  const grant = await SimklConnection.grantId(user.uuid, variant);
  if (!grant) return;
  const source = recommendationSourceId(variant);
  const catalogs = await Promise.all(
    types.flatMap((type) =>
      [false, true].map(async (anime) => {
        const key = recommendationKey(user, type, grant, anime);
        let cached = await snapshots.get(key);
        const enabled = (anime ? animeRows : regularRows).filter((id) =>
          catalogEnabled(user, source, type, id)
        );
        if (preview && enabled.length) {
          const warmup = getRecommendationCatalog(user, type, enabled[0]).catch(
            () => undefined
          );
          if (!cached) {
            await Promise.race([
              warmup,
              setTimeout(1500, undefined, { ref: false }),
            ]);
            cached = await snapshots.get(key);
          }
        }
        const available = enabled.filter((id) => {
          if (id === 'anime-top') return true;
          if (preview && !cached?.rows[id]?.length) return false;
          return (
            !namedRows.has(id) ||
            !cached ||
            (cached.names?.[id] && cached.rows[id]?.length)
          );
        });
        // A viewer who enables only genre or theme rows still needs a refresh
        // after the current snapshot has no matches and advertises no catalogs.
        if (!preview && enabled.length && !available.length) {
          void getRecommendationCatalog(user, type, enabled[0]).catch(
            () => undefined
          );
        }
        return available.map((id) => ({
          id,
          type,
          name: cached?.names?.[id] ?? rows[id],
        }));
      })
    )
  );
  return {
    id: source,
    name:
      'Recommendations (' +
      (user.variants?.find(({ id }) => id === variant)?.name ||
        variant ||
        'Base') +
      ')',
    version: '1.0.0',
    types,
    resources: ['catalog'],
    catalogs: catalogs.flat(),
  };
}

export async function recommendationCatalogPreviews(user: UserData) {
  if (!user.uuid || !user.personalizedRecommendations?.enabled) return [];
  const scopes = [
    '',
    ...(user.variants ?? [])
      .filter((variant) => variant.enabled !== false)
      .map(({ id }) => id),
  ];
  const manifests = await Promise.all(
    scopes.map(async (variant) => {
      const base = {
        ...user,
        activeVariants: undefined,
        autoVariants: undefined,
      };
      try {
        const scoped = variant ? applyVariants(base, [variant]).userData : base;
        return await recommendationManifest(scoped, true);
      } catch {
        return undefined;
      }
    })
  );
  return manifests.flatMap(
    (manifest) =>
      manifest?.catalogs.map((catalog) => ({
        ...catalog,
        id: manifest.id + '.' + catalog.id,
        addonName: manifest.name,
        hideable: true,
        genreRequired: false,
        searchable: false,
      })) ?? []
  );
}
export function recommendationKey(
  user: UserData,
  type: MediaType,
  grantId: string,
  anime = false
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        userScopeKey(user),
        type,
        user.personalizedRecommendations,
        grantId,
        user.tmdbApiKey,
        user.tmdbAccessToken,
        ...(anime ? ['anime'] : []),
      ])
    )
    .digest('hex');
}

async function mapBatches<T, U>(
  items: T[],
  fn: (item: T) => Promise<U>
): Promise<U[]> {
  const result: U[] = [];
  for (let i = 0; i < items.length; i += 6) {
    result.push(...(await Promise.all(items.slice(i, i + 6).map(fn))));
  }
  return result;
}

function preferred(
  profile: Profile,
  axis: Feature,
  count = 3,
  minimum = 1
): string[] {
  return [...profile[axis]]
    .filter(([, item]) => item.count >= minimum && item.score > 0)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, count)
    .map(([id]) => id);
}

export function eligible(
  title: Title,
  watched: Set<string>,
  settings: Settings,
  type: MediaType
): boolean {
  const threshold = discovery[settings.style ?? 'balanced'];
  const excluded =
    type === 'movie'
      ? settings.excludedMovieGenres
      : settings.excludedSeriesGenres;
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  const releaseAllowed = settings.toYear
    ? (title.year ?? Infinity) <= settings.toYear
    : title.releaseDate
      ? title.releaseDate <= today
      : (title.year ?? 0) <= Number(today.slice(0, 4));
  return Boolean(
    title.name &&
    title.imdb &&
    /^tt\d+$/.test(title.imdb) &&
    !title.adult &&
    !watched.has(title.imdb) &&
    title.votes >= threshold.min &&
    title.rating >= threshold.rating &&
    (!('max' in threshold) || title.votes <= threshold.max) &&
    (!settings.fromYear || (title.year ?? 0) >= settings.fromYear) &&
    releaseAllowed &&
    !title.genres.some((id) => excluded?.includes(id)) &&
    !title.keywords.some((id) => settings.excludedKeywords?.includes(id))
  );
}

async function refresh(
  user: UserData,
  type: MediaType,
  grantId: string,
  anime: boolean,
  cached?: Snapshot
): Promise<Snapshot> {
  const settings = user.personalizedRecommendations!;
  const now = Date.now();
  const accessToken = await SimklConnection.accessToken(
    user.uuid!,
    simklVariant(user),
    grantId
  );
  if (!accessToken)
    throw new SimklAuthorizationError('Simkl authorization has expired.');
  const history = await new SimklHistory(
    bootstrap.simklClientId,
    accessToken,
    userScopeKey(user),
    grantId
  ).history(anime ? 'anime' : type);
  history.sort(
    (a, b) =>
      (b.watchedAt ?? 0) - (a.watchedAt ?? 0) || a.imdb.localeCompare(b.imdb)
  );
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(history))
    .digest('hex');
  if (
    cached?.fingerprint === fingerprint &&
    now - cached.generatedAt < 86400000
  ) {
    return { ...cached, checkedAt: now };
  }
  const rotation =
    cached?.fingerprint === fingerprint ? (cached.rotation ?? 0) + 1 : 0;
  const empty: Snapshot['rows'] = {
    'anime-top': [],
    top: [],
    watched: [],
    loved: [],
    genres: [],
    'genres-2': [],
    'genres-3': [],
    themes: [],
    'themes-2': [],
    'themes-3': [],
    creators: [],
    positive: [],
  };
  if (!anime && !history.length)
    return { checkedAt: now, generatedAt: now, fingerprint, rows: empty };

  const tmdb = new RecommendationTmdb({
    apiKey: user.tmdbApiKey,
    accessToken: user.tmdbAccessToken,
  });
  const watched = new Set(history.map(({ imdb }) => imdb));
  const positive = history.filter(
    (item) => (item.rating ?? 0) >= 7 || item.plays >= 2
  );
  const sample = [
    ...new Set([...history.slice(0, 1), ...positive.slice(0, 110), ...history]),
  ].slice(0, 200);
  const enriched = (
    await mapBatches(sample, async (item) => {
      const media =
        anime && item.animeType
          ? item.animeType === 'movie'
            ? 'movie'
            : 'series'
          : type;
      const id =
        (anime && item.animeType ? item.tmdb : undefined) ??
        (item.imdb ? await tmdb.find(item.imdb, media) : undefined);
      const title = id ? await tmdb.details(id, media) : undefined;
      return title ? { history: item, title, media } : undefined;
    })
  ).filter((item) => item !== undefined);
  if (!anime && !enriched.length)
    return { checkedAt: now, generatedAt: now, fingerprint, rows: empty };

  enriched.sort(
    (a, b) => (b.history.watchedAt ?? 0) - (a.history.watchedAt ?? 0)
  );
  const profile = buildProfile(enriched, type, now);
  const favorites = enriched
    .filter(({ history: item }) => positive.includes(item))
    .sort((a, b) => (b.history.rating ?? 0) - (a.history.rating ?? 0));
  const lovedSeeds = enriched
    .filter(({ history: item }) => (item.rating ?? 0) >= 9 || item.plays >= 2)
    .slice(0, 3);
  const loved = lovedSeeds[rotation % lovedSeeds.length]?.title;
  const watchedSeeds = enriched
    .filter(
      ({ history: item, title }) =>
        item.watchedAt !== undefined && title.id !== loved?.id
    )
    .slice(0, 3);
  const recent = (
    watchedSeeds[rotation % watchedSeeds.length] ??
    enriched.find(({ history: item }) => item.watchedAt !== undefined)
  )?.title;
  const seeds = anime
    ? enriched
        .filter(({ media }) => media === type)
        .slice(0, 8)
        .map(({ title }) => title)
    : [
        ...new Set([
          recent,
          loved,
          ...favorites.slice(0, 8).map(({ title }) => title),
        ]),
      ].filter((item) => item !== undefined);
  const watchedAnimeIds = anime
    ? new Set([
        ...history
          .filter(
            (item) =>
              item.tmdb &&
              item.animeType &&
              (item.animeType === 'movie') === (type === 'movie')
          )
          .map((item) => item.tmdb),
        ...enriched
          .filter(({ media }) => media === type)
          .map(({ title }) => title.id),
      ])
    : undefined;
  const threshold = discovery[settings.style ?? 'balanced'];
  const params: Record<string, string> = {
    'vote_average.gte': String(threshold.rating),
    'vote_count.gte': String(threshold.min),
    include_adult: 'false',
    sort_by:
      settings.style === 'gems' ? 'vote_average.desc' : 'popularity.desc',
  };
  if ('max' in threshold) params['vote_count.lte'] = String(threshold.max);
  const date = type === 'movie' ? 'primary_release_date' : 'first_air_date';
  if (settings.fromYear) params[date + '.gte'] = settings.fromYear + '-01-01';
  const latest = settings.toYear
    ? settings.toYear + '-12-31'
    : new Date(now).toISOString().slice(0, 10);
  params[date + '.lte'] = latest;
  const excluded =
    type === 'movie'
      ? settings.excludedMovieGenres
      : settings.excludedSeriesGenres;
  if (excluded?.length) params.without_genres = excluded.join(',');
  if (settings.excludedKeywords?.length)
    params.without_keywords = settings.excludedKeywords.join(',');

  const genres = preferred(profile, 'genres', 30)
    .filter((id) => !excluded?.includes(id))
    .slice(0, genreRows.length);
  const themes = preferred(profile, 'keywords', 30)
    .filter((id) => !settings.excludedKeywords?.includes(id))
    .slice(0, themeRows.length);
  const names: Snapshot['names'] = {};
  if (recent) names.watched = 'Because you watched ' + recent.name;
  if (loved) names.loved = 'Because you loved ' + loved.name;
  const titleCase = (name: string) =>
    name.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
  genres.forEach((id, index) => {
    const name = enriched.find(({ title }) => title.genreNames?.[id])?.title
      .genreNames?.[id];
    if (name) names[genreRows[index]] = name;
  });
  themes.forEach((id, index) => {
    const name = enriched.find(({ title }) => title.keywordNames?.[id])?.title
      .keywordNames?.[id];
    if (name) names[themeRows[index]] = titleCase(name);
  });
  const creators = [
    ...new Set([
      ...preferred(profile, 'directors', 3, 2),
      ...preferred(profile, 'cast', 3, 2),
    ]),
  ];
  const country = preferred(profile, 'countries', 1)[0];
  const language = preferred(profile, 'languages', 1)[0];
  const era = Number(preferred(profile, 'eras', 1)[0]?.slice(0, 4));
  const from = Math.max(era, settings.fromYear ?? era);
  const to = Math.min(era + 9, settings.toYear ?? era + 9);
  const discoverRows: { row: Row; filter: Record<string, string> }[] = [
    ...(country
      ? [{ row: 'top' as const, filter: { with_origin_country: country } }]
      : []),
    ...(language
      ? [{ row: 'top' as const, filter: { with_original_language: language } }]
      : []),
    ...(from <= to
      ? [
          {
            row: 'top' as const,
            filter: {
              [date + '.gte']: from + '-01-01',
              [date + '.lte']: [to + '-12-31', latest].sort()[0],
            },
          },
        ]
      : []),
    ...genres.map((id, index) => ({
      row: genreRows[index],
      filter: { with_genres: id },
    })),
    ...themes.map((id, index) => ({
      row: themeRows[index],
      filter: { with_keywords: id },
    })),
    ...creators.map((id) => ({
      row: 'creators' as const,
      filter: { with_people: id },
    })),
  ];
  if (anime) {
    params.with_genres = '16';
    params.with_original_language = 'ja';
    if ('max' in threshold) params['vote_count.lte'] = String(threshold.max);
    discoverRows.splice(
      0,
      discoverRows.length,
      ...[1, 2, 3].map((page) => ({
        row: 'anime-top' as const,
        filter: { page: String(page) },
      })),
      ...themes.map((id) => ({
        row: 'anime-top' as const,
        filter: { with_keywords: id },
      }))
    );
  }
  if (!anime) {
    for (const [row, seed] of [
      ['watched', recent],
      ['loved', loved],
    ] as const) {
      if (!seed?.genres.length) continue;
      const filter = { with_genres: seed.genres.slice(0, 3).join('|') };
      discoverRows.push(
        { row, filter },
        { row, filter: { ...filter, page: '2' } }
      );
    }
  }
  const discovered = await mapBatches(
    discoverRows,
    async ({ row, filter }) => ({
      row,
      titles: await tmdb.candidates(type, { ...params, ...filter }),
    })
  );
  const seeded = await mapBatches(seeds, async (seed) => {
    const titles = await tmdb.candidates(type, {}, seed.id);
    const viable = titles.filter(
      (item) => item.votes >= threshold.min && item.rating >= threshold.rating
    );
    const similar =
      viable.length < limit
        ? await tmdb.candidates(type, {}, seed.id, 'similar')
        : [];
    return { id: seed.id, titles: [...titles, ...similar] };
  });
  const source = new Map(seeded.map(({ id, titles }) => [id, titles]));
  const candidates: Record<Row, Title[]> = {
    'anime-top': anime
      ? [
          ...discovered.flatMap(({ titles }) => titles),
          ...seeded.flatMap(({ titles }) => titles),
        ]
      : [],
    top: [
      ...discovered
        .filter(({ row }) => row !== 'watched' && row !== 'loved')
        .flatMap(({ titles }) => titles),
      ...seeded.flatMap(({ titles }) => titles),
    ],
    watched: recent
      ? [
          ...(source.get(recent.id) ?? []),
          ...discovered
            .filter(({ row }) => row === 'watched')
            .flatMap(({ titles }) => titles),
        ]
      : [],
    loved: loved
      ? [
          ...(source.get(loved.id) ?? []),
          ...discovered
            .filter(({ row }) => row === 'loved')
            .flatMap(({ titles }) => titles),
        ]
      : [],
    genres: discovered.find(({ row }) => row === 'genres')?.titles ?? [],
    'genres-2': discovered.find(({ row }) => row === 'genres-2')?.titles ?? [],
    'genres-3': discovered.find(({ row }) => row === 'genres-3')?.titles ?? [],
    themes: discovered.find(({ row }) => row === 'themes')?.titles ?? [],
    'themes-2': discovered.find(({ row }) => row === 'themes-2')?.titles ?? [],
    'themes-3': discovered.find(({ row }) => row === 'themes-3')?.titles ?? [],
    creators: discovered
      .filter(({ row }) => row === 'creators')
      .flatMap(({ titles }) => titles),
    positive: favorites
      .slice(0, 8)
      .flatMap(({ title }) => source.get(title.id) ?? []),
  };
  const ids = [
    ...new Set(
      (anime ? animeRows : regularRows).flatMap((row) => {
        const viable = candidates[row].filter(
          (item) =>
            item.votes >= threshold.min && item.rating >= threshold.rating
        );
        const unique = [
          ...new Map(viable.map((item) => [item.id, item])).values(),
        ];
        return rank(unique, profile, type)
          .slice(0, 72)
          .map(({ title }) => title.id);
      })
    ),
  ];
  const details = new Map(
    await mapBatches(
      ids,
      async (id) => [id, await tmdb.details(id, type)] as const
    )
  );

  for (const row of anime ? animeRows : regularRows) {
    const pool = [...new Set(candidates[row].map(({ id }) => id))].flatMap(
      (id) => {
        const item = details.get(id);
        return item &&
          (!anime ||
            (!watchedAnimeIds?.has(id) &&
              item.genres.includes('16') &&
              (item.language === 'ja' || item.countries.includes('JP')))) &&
          eligible(item, watched, settings, type)
          ? [item]
          : [];
      }
    );
    const seed =
      row === 'watched' ? recent : row === 'loved' ? loved : undefined;
    const related = new Set(
      seed ? source.get(seed.id)?.map(({ id }) => id) : []
    );
    const ranked = rank(pool, profile, type)
      .map(({ title }) => title)
      .sort((a, b) => Number(related.has(b.id)) - Number(related.has(a.id)));
    const selected =
      row === 'top' ? diversify(ranked, limit) : ranked.slice(0, limit);
    empty[row] = selected.map((item) => ({
      id: item.imdb!,
      type,
      name: item.name,
      poster: item.poster,
      description: item.description,
      releaseInfo: item.year,
    }));
  }
  return {
    checkedAt: now,
    generatedAt: now,
    fingerprint,
    rotation,
    rows: empty,
    names,
  };
}

export async function getRecommendationCatalog(
  user: UserData,
  type: string,
  id: string
): Promise<MetaPreview[]> {
  if (
    !user.uuid ||
    !user.personalizedRecommendations?.enabled ||
    !types.includes(type as MediaType) ||
    !rowIds.includes(id as Row) ||
    !catalogEnabled(
      user,
      recommendationSourceId(simklVariant(user)),
      type,
      id as Row
    )
  )
    return [];
  const grantId = await SimklConnection.grantId(user.uuid, simklVariant(user));
  if (!grantId) return [];
  const media = type as MediaType;
  const row = id as Row;
  const anime = row === 'anime-top';
  const key = recommendationKey(user, media, grantId, anime);
  const cached = await snapshots.get(key);
  const interval =
    (user.personalizedRecommendations?.refreshHours ?? 6) * 3600000;
  if (cached && Date.now() - cached.checkedAt < interval)
    return cached.rows[row];
  if (await retryAfter.get(key)) return cached?.rows[row] ?? [];

  let task = pending.get(key);
  if (!task) {
    task = refresh(user, media, grantId, anime, cached)
      .then(async (snapshot) => {
        await snapshots.set(key, snapshot, interval / 1000 + 7 * 86400);
        return snapshot;
      })
      .catch(async (error: unknown) => {
        await retryAfter.set(
          key,
          true,
          error instanceof SimklRateLimit ? error.seconds : 60
        );
        if (error instanceof SimklAuthorizationError) {
          await snapshots.delete(key);
          return undefined;
        }
        return cached;
      })
      .finally(() => pending.delete(key));
    pending.set(key, task);
  }
  return cached?.rows[row] ?? (await task)?.rows[row] ?? [];
}
