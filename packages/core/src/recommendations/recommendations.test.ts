import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, mock, test } from 'node:test';
import { initialiseConfig } from '../config/index.js';
import { SettingsRepository } from '../db/repositories/settings.js';
import { UserDataSchema } from '../db/schemas.js';
import { AIOStreams } from '../main/index.js';
import { exposedCatalogs, getCatalogPage } from '../jellyfin/library.js';
import { sanitiseTemplateConfig } from '../utils/template-sanitise.js';
import {
  eligible,
  getRecommendationCatalog,
  recommendationKey,
  recommendationManifest,
  recommendationCatalogPreviews,
  recommendationSource,
} from './catalogs.js';
import {
  buildProfile,
  diversify,
  evidence,
  rank,
  type Feature,
  type HistoryItem,
  type Title,
} from './ranking.js';
import { RecommendationTmdb, SimklHistory } from './sources.js';
import { recommendationRowIds } from './rows.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/watchly.json', import.meta.url), 'utf8')
) as {
  now: number;
  titles: Title[];
  history: HistoryItem[];
  evidence: number[];
  profile: Record<Feature, Record<string, number>>;
  candidates: Title[];
  scores: number[];
  order: number[];
  eligible: number[];
  genre_exclusion: number[];
  catalog: number[];
};

import { SimklConnection } from './simkl-connection.js';
const user = UserDataSchema.parse({
  uuid: 'f353daee-b7e1-4b25-ab79-8109997b7bea',

  tmdbApiKey: 'fake-key',
  sortCriteria: { global: [] },
  formatter: { id: 'gdrive' },
  presets: [],
  personalizedRecommendations: { enabled: true },
});

before(async () => {
  mock.method(
    SimklConnection,
    'grantId',
    async (uuid: string, variant: string) =>
      variant === 'kids' ? undefined : JSON.stringify([uuid, variant])
  );
  mock.method(
    SimklConnection,
    'accessToken',
    async (_uuid: string, variant: string) =>
      variant === 'viewer' ? 'variant-token' : 'base-token'
  );
  const version = mock.method(SettingsRepository, 'getVersion', async () => 0);
  const rows = mock.method(SettingsRepository, 'getAll', async () => []);
  try {
    await initialiseConfig();
  } finally {
    version.mock.restore();
    rows.mock.restore();
  }
});

function almostEqual(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test('Watchly fixture reproduces Simkl evidence, profile, scores and order', () => {
  const samples = fixture.history.map((history, index) => ({
    history,
    title: fixture.titles[index],
  }));
  for (const [index, sample] of samples.entries()) {
    almostEqual(evidence(sample.history, fixture.now), fixture.evidence[index]);
  }
  const profile = buildProfile(samples, 'movie', fixture.now);
  for (const [feature, values] of Object.entries(fixture.profile)) {
    const actual = profile[feature as Feature];
    assert.equal(actual.size, Object.keys(values).length);
    for (const [id, score] of Object.entries(values))
      almostEqual(actual.get(id)!.score, score);
  }
  const ranked = rank(fixture.candidates, profile, 'movie');
  assert.deepEqual(
    ranked.map(({ title }) => title.id),
    fixture.order
  );
  for (const { title, score } of ranked) {
    almostEqual(score, fixture.scores[fixture.candidates.indexOf(title)]);
  }
  const series = buildProfile(samples, 'series', fixture.now);
  assert.equal(series.runtime.has('long'), true);
  assert.notEqual(
    rank(fixture.candidates, series, 'series')[0].score,
    ranked[0].score
  );
});

test('catalog filtering excludes watched IDs, genre and keyword exclusions, and low confidence', () => {
  const watched = new Set(fixture.history.map(({ imdb }) => imdb));
  const candidates = fixture.candidates;
  const viable = candidates.filter((item) =>
    eligible(item, watched, {}, 'movie')
  );
  assert.deepEqual(
    viable.map(({ id }) => id),
    fixture.eligible
  );
  const profile = buildProfile(
    fixture.history.map((history, index) => ({
      history,
      title: fixture.titles[index],
    })),
    'movie',
    fixture.now
  );
  assert.deepEqual(
    diversify(
      rank(viable, profile, 'movie').map(({ title }) => title),
      24
    ).map(({ id }) => id),
    fixture.catalog
  );
  assert.deepEqual(
    candidates
      .filter((item) =>
        eligible(item, watched, { excludedMovieGenres: ['28'] }, 'movie')
      )
      .map(({ id }) => id),
    fixture.genre_exclusion
  );
  const settings = { excludedMovieGenres: ['28'], excludedKeywords: ['8'] };
  assert.deepEqual(
    candidates.filter((item) => eligible(item, watched, settings, 'movie')),
    []
  );
  assert.deepEqual(
    candidates
      .filter((item) => eligible(item, watched, settings, 'series'))
      .map(({ id }) => id),
    [101]
  );
});

test('diversity caps primary genres and recurring cast', () => {
  const base = fixture.candidates[0];
  const sameCast = Array.from({ length: 5 }, (_, id) => ({
    ...base,
    id,
    genres: [String(id)],
  }));
  assert.equal(diversify(sameCast, 8).length, 3);
  const sameGenre = sameCast.map((item) => ({
    ...item,
    genres: ['28'],
    cast: [],
    directors: [],
  }));
  assert.equal(diversify(sameGenre, 4).length, 2);
});

test('catalog registration is opt-in and variant authentication does not fall back to the base user', async (t) => {
  const disabled = { ...user, personalizedRecommendations: undefined };
  const ordinary = await new AIOStreams(disabled).initialise();
  assert.equal(ordinary.getCatalogs().length, 0);
  assert.equal(
    await recommendationManifest({ ...user, activeVariants: ['kids'] }),
    undefined
  );
  const scoped = {
    ...user,
    activeVariants: ['viewer'],
  };
  assert.equal((await recommendationManifest(scoped))?.catalogs.length, 22);
  const aio = await new AIOStreams(user).initialise();
  const actual = aio
    .getCatalogs()
    .filter(({ id }) => id.startsWith(recommendationSource + '.'));
  assert.equal(actual.length, 22);
  assert.equal(exposedCatalogs(aio).length, 22);
  const shared = sanitiseTemplateConfig(
    {
      ...scoped,
      simklClientId: 'old-app',
      simklAccessToken: 'old-token',
      simklVariantAccounts: { viewer: 'old-grant' },
    },
    () => undefined
  );
  assert.equal(shared.simklAccessToken, undefined);
  assert.equal(shared.simklClientId, undefined);
  assert.equal(shared.simklVariantAccounts, undefined);
  const hidden = await new AIOStreams({
    ...user,
    catalogModifications: [
      { id: recommendationSource + '.top', type: 'movie', enabled: false },
    ],
  }).initialise();
  assert.equal(hidden.getCatalogs().length, 21);
  const viewer = await new AIOStreams(scoped).initialise();
  assert.ok(
    viewer
      .getCatalogs()
      .every(({ id }) => id.startsWith(recommendationSource + '-viewer.'))
  );
  assert.deepEqual(
    (await viewer.getCatalog('movie', recommendationSource + '.top')).data,
    []
  );
  t.mock.method(SimklHistory.prototype, 'history', async () => []);
  const previews = await recommendationCatalogPreviews(user);
  assert.deepEqual(previews, []);
  assert.notEqual(
    recommendationKey(user, 'movie', 'base-grant'),
    recommendationKey(scoped, 'movie', 'base-grant')
  );
  assert.notEqual(
    recommendationKey(user, 'movie', 'base-grant'),
    recommendationKey(user, 'series', 'base-grant')
  );
  assert.notEqual(
    recommendationKey(user, 'movie', 'base-grant'),
    recommendationKey({ ...user, uuid: 'other' }, 'movie', 'base-grant')
  );
  assert.notEqual(
    recommendationKey(user, 'movie', 'base-grant'),
    recommendationKey(user, 'movie', 'replacement-grant')
  );
});

test('catalogs share a cold refresh and return stale rows through an outage', async (t) => {
  const scoped = {
    ...user,
    uuid: 'cold-refresh',
    personalizedRecommendations: { enabled: true, refreshHours: 1 },
  };
  const seed = {
    ...fixture.titles[0],
    name: 'Friends',
    genreNames: { '28': 'Action', '18': 'Drama' },
    keywordNames: { '7': 'friendship' },
  };
  const candidate = fixture.candidates[0];
  let upstreamFailure = false;
  const history = t.mock.method(SimklHistory.prototype, 'history', async () => {
    if (upstreamFailure) throw new Error('outage');
    return [fixture.history[0]];
  });
  t.mock.method(RecommendationTmdb.prototype, 'find', async () => seed.id);
  t.mock.method(RecommendationTmdb.prototype, 'details', async (id: number) =>
    id === seed.id ? seed : candidate
  );
  t.mock.method(RecommendationTmdb.prototype, 'candidates', async () => [
    candidate,
  ]);
  const clock = t.mock.method(Date, 'now', () => fixture.now);
  const [top, watched, loved, genres, themes, positive, creators] =
    await Promise.all(
      [
        'top',
        'watched',
        'loved',
        'genres',
        'themes',
        'positive',
        'creators',
      ].map((row) => getRecommendationCatalog(scoped, 'movie', row))
    );
  for (const row of [top, watched, loved, genres, themes, positive]) {
    assert.deepEqual(
      row.map(({ id }) => id),
      [candidate.imdb]
    );
  }
  assert.deepEqual(creators, []);
  const engine = await new AIOStreams(scoped).initialise();
  const names = Object.fromEntries(
    engine
      .getCatalogs()
      .filter(({ type }) => type === 'movie')
      .map(({ id, name }) => [id.split('.').at(-1), name])
  );
  assert.equal(names.watched, 'Because you watched Friends');
  assert.equal(names.loved, 'Because you loved Friends');
  assert.equal(names.genres, 'Action');
  assert.equal(names['genres-2'], 'Drama');
  assert.equal(names.themes, 'Friendship');
  const previews = await recommendationCatalogPreviews({
    ...scoped,
    catalogModifications: recommendationRowIds.map((id) => ({
      id: recommendationSource + '.' + id,
      type: 'series',
      enabled: false,
    })),
  });
  assert.ok(
    previews.some(
      ({ name, addonName }) =>
        name === 'Because you watched Friends' &&
        addonName === 'Recommendations (Base)'
    )
  );
  assert.ok(!previews.some(({ name }) => name === 'Favorite Theme 2'));
  assert.equal(names['themes-2'], undefined);
  const muted = {
    ...scoped,
    catalogModifications: [
      { id: recommendationSource + '.watched', type: 'movie', enabled: false },
    ],
  };
  assert.deepEqual(
    await getRecommendationCatalog(muted, 'movie', 'watched'),
    []
  );
  assert.ok(
    !(await recommendationManifest(muted))?.catalogs.some(
      ({ id, type }) => id === 'watched' && type === 'movie'
    )
  );
  const catalog = exposedCatalogs(engine).find(
    ({ id, type }) => id === recommendationSource + '.top' && type === 'movie'
  )!;
  const page = await getCatalogPage(engine, catalog, {
    startIndex: 0,
    limit: 24,
    singlePage: true,
  });
  assert.deepEqual(
    page.items.map(({ id }) => id),
    [candidate.imdb]
  );
  assert.equal(history.mock.callCount(), 1);
  assert.deepEqual(await getRecommendationCatalog(scoped, 'movie', 'top'), top);
  assert.equal(history.mock.callCount(), 1);
  clock.mock.mockImplementation(() => fixture.now + 3600001);
  upstreamFailure = true;
  assert.deepEqual(await getRecommendationCatalog(scoped, 'movie', 'top'), top);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(history.mock.callCount(), 2);
  assert.deepEqual(await getRecommendationCatalog(scoped, 'movie', 'top'), top);
  assert.equal(history.mock.callCount(), 2);
  assert.deepEqual(
    await getRecommendationCatalog(
      { ...scoped, uuid: 'new-account-outage' },
      'movie',
      'top'
    ),
    []
  );
});

test('Simkl activity deltas update ratings, remove deleted titles, and skip an unchanged library', async (t) => {
  let pass = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async (url: URL) => {
    const item = (simkl: number, rating: number | null) => ({
      movie: { ids: { simkl, imdb: 'tt' + simkl } },
      status: 'completed',
      user_rating: rating,
    });
    if (url.pathname === '/sync/activities') {
      return Response.json({
        all: pass ? 'later' : 'initial',
        movies: {
          completed: 'initial',
          rated_at: pass ? 'later' : 'initial',
          removed_from_list: pass ? 'later' : null,
        },
      });
    }
    if (url.pathname === '/sync/ratings/movies') {
      assert.equal(url.searchParams.get('date_from'), 'initial');
      return Response.json({ movies: [item(1, null)] });
    }
    if (url.searchParams.get('extended') === 'simkl_ids_only') {
      return Response.json({ movies: [{ movie: { ids: { simkl: 1 } } }] });
    }
    return Response.json({ movies: [item(1, 9), item(2, 7)] });
  });
  const provider = new SimklHistory('test-client', 'test-token', 'delta-test');
  assert.deepEqual(
    (await provider.history('movie')).map(({ rating }) => rating),
    [9, 7]
  );
  pass++;
  assert.deepEqual(
    (await provider.history('movie')).map(({ rating }) => rating),
    [undefined]
  );
  assert.equal(fetch.mock.callCount(), 5);
  assert.equal((await provider.history('movie')).length, 1);
  assert.equal(fetch.mock.callCount(), 6);
});
test('base and variant account histories produce separate catalogs for the same configuration', async (t) => {
  const candidates = fixture.candidates.slice(0, 2);
  const request = t.mock.method(
    globalThis,
    'fetch',
    async (url: URL, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization');
      assert.ok(
        auth === 'Bearer base-token' || auth === 'Bearer variant-token'
      );
      if (url.pathname === '/sync/activities') {
        return Response.json({
          all: 'initial',
          movies: { completed: 'initial' },
        });
      }
      assert.equal(url.pathname, '/sync/all-items/movies');
      const title = candidates[auth === 'Bearer base-token' ? 0 : 1];
      return Response.json({
        movies: [
          {
            movie: { ids: { simkl: title.id, imdb: title.imdb } },
            status: 'completed',
            user_rating: 9,
          },
        ],
      });
    }
  );
  t.mock.method(
    RecommendationTmdb.prototype,
    'find',
    async (imdb: string) => candidates.find((item) => item.imdb === imdb)?.id
  );
  t.mock.method(RecommendationTmdb.prototype, 'details', async (id: number) =>
    candidates.find((item) => item.id === id)
  );
  t.mock.method(
    RecommendationTmdb.prototype,
    'candidates',
    async () => candidates
  );
  const base = {
    ...user,
    uuid: 'test-base-and-variant',
  };
  const [first, second] = await Promise.all([
    getRecommendationCatalog(base, 'movie', 'top'),
    getRecommendationCatalog(
      { ...base, activeVariants: ['viewer'] },
      'movie',
      'top'
    ),
  ]);
  assert.deepEqual(
    first.map(({ id }) => id),
    [candidates[1].imdb]
  );
  assert.deepEqual(
    second.map(({ id }) => id),
    [candidates[0].imdb]
  );
  assert.equal(request.mock.callCount(), 4);
  const previews = await recommendationCatalogPreviews({
    ...base,
    trusted: true,
    variants: [
      { id: 'viewer', name: 'Rodrigo', script: 'set addonName = "Viewer"' },
    ],
    catalogModifications: [
      ...['', '-viewer'].flatMap((suffix) =>
        recommendationRowIds.map((id) => ({
          id: recommendationSource + suffix + '.' + id,
          type: 'series',
          enabled: false,
        }))
      ),
      {
        id: recommendationSource + '-viewer.top',
        type: 'movie',
        enabled: false,
      },
    ],
  });
  assert.ok(
    previews.some(
      ({ addonName, name }) =>
        addonName === 'Recommendations (Rodrigo)' &&
        name === 'Because you loved ' + candidates[1].name
    )
  );
  assert.ok(
    !previews.some(({ id }) => id === recommendationSource + '-viewer.top')
  );
  assert.ok(previews.some(({ id }) => id === recommendationSource + '.top'));
  assert.equal(request.mock.callCount(), 4);
});

test('Simkl Retry-After suppresses concurrent polls for both media types', async (t) => {
  const request = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(null, { status: 429, headers: { 'retry-after': '120' } })
  );
  const provider = new SimklHistory('rate-client', 'rate-token', 'rate-test');
  const outcomes = await Promise.allSettled([
    provider.history('movie'),
    provider.history('series'),
  ]);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected')
      assert.equal(outcome.reason.seconds, 120);
  }
  assert.equal(request.mock.callCount(), 1);
});

test('the open year range ends today and an explicit future year is preserved', (t) => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 3));
  const future = {
    ...fixture.candidates[0],
    year: 2026,
    releaseDate: '2026-12-01',
  };
  assert.equal(eligible(future, new Set(), {}, 'movie'), false);
  assert.equal(eligible(future, new Set(), { toYear: 2026 }, 'movie'), true);
});

test('keyword lookup resolves saved IDs and reuses search matches', async (t) => {
  const tmdb = new RecommendationTmdb({ apiKey: 'test-key' });
  const upstream = t.mock.method(
    tmdb as unknown as { getJson: (path: string) => Promise<unknown> },
    'getJson',
    async (path: string) => {
      if (path === '/search/keyword')
        return { results: [{ id: 123, name: 'test keyword' }] };
      assert.equal(path, '/keyword/456');
      return { id: 456, name: 'saved keyword' };
    }
  );
  assert.deepEqual(
    await tmdb.keywords('regression keyword lookup', ['123', '456']),
    [
      { id: 123, name: 'test keyword' },
      { id: 456, name: 'saved keyword' },
    ]
  );
  assert.equal(upstream.mock.callCount(), 2);
});
