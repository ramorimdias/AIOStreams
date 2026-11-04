import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  catalogNameOverride,
  isRecommendationCatalog,
} from './catalog-name.js';

test('recommendations follow upstream unless there is a custom name', () => {
  const id = '523e3b0.recommendations.series.themes';
  assert.equal(isRecommendationCatalog(id), true);
  assert.equal(catalogNameOverride({ id }), undefined);
  assert.equal(
    catalogNameOverride({ id, name: 'Favorite Theme 1' }),
    undefined
  );
  assert.equal(
    catalogNameOverride({ id, name: 'Favorite Genre 3' }),
    undefined
  );
  assert.equal(
    catalogNameOverride({ id, name: 'My book adaptations' }),
    'My book adaptations'
  );
  assert.equal(
    catalogNameOverride({ id, name: 'Favorite Theme 1', nameIsCustom: true }),
    'Favorite Theme 1'
  );
  assert.equal(
    catalogNameOverride({ id: 'other.catalog', name: 'Favorite Theme 1' }),
    'Favorite Theme 1'
  );
  assert.equal(
    isRecommendationCatalog('other.myrecommendations.catalog'),
    false
  );
});

test('saved and resaved preferences do not turn upstream labels into overrides', async () => {
  const { UserDataSchema } = await import('../db/schemas.js');
  const schema = UserDataSchema.shape.catalogModifications;
  const id = '523e3b0.recommendations.series.themes';
  const preferences = schema.parse([
    { id, type: 'series', name: 'Favorite Theme 1', enabled: true },
  ])!;
  assert.equal(preferences[0].name, undefined);
  const afterEdit = schema.parse(
    JSON.parse(
      JSON.stringify([
        { ...preferences[0], enabled: false, upstreamName: 'Based on Books' },
      ])
    )
  )!;
  assert.equal(afterEdit[0].name, undefined);
  assert.equal(afterEdit[0].enabled, false);
  assert.equal(afterEdit[0].upstreamName, 'Based on Books');
  const custom = schema.parse([
    { ...afterEdit[0], name: 'My Books', nameIsCustom: true },
  ])!;
  assert.equal(custom[0].name, 'My Books');
  assert.equal(
    schema.parse([
      { id, type: 'series', name: 'Favorite Theme 1', nameIsCustom: true },
    ])![0].name,
    'Favorite Theme 1'
  );
});
