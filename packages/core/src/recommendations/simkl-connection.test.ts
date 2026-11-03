import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  closeDb,
  initDb,
  initialiseConfig,
  SimklConnection,
} from '../index.js';
import { bootstrap } from '../config/bootstrap.js';

import { sql } from '../db/sql.js';

test('Simkl device consent stores encrypted, scoped grants and refreshes server-side', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'aiostreams-simkl-'));
  const cwd = process.cwd();
  const original = {
    simklClientId: bootstrap.simklClientId,
    simklClientSecret: bootstrap.simklClientSecret,
  };
  Object.assign(bootstrap, {
    simklClientId: 'test-app',
    simklClientSecret: 'test-secret',
  });
  t.after(async () => {
    Object.assign(bootstrap, original);
    await closeDb();
    rmSync(folder, { recursive: true, force: true });
  });

  process.chdir(folder);
  let db;
  try {
    db = await initDb('sqlite://./test.sqlite');
  } finally {
    process.chdir(cwd);
  }
  await initialiseConfig();
  await db.exec(sql`INSERT INTO users (uuid, password_hash, config, config_salt)
    VALUES ('owner', 'unused', 'unused', 'unused')`);

  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let approved = false;
  let refreshed = 0;
  let revoked = false;
  const mockFetch = t.mock.method(
    globalThis,
    'fetch',
    async (url: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as URLSearchParams);
      assert.equal(body.get('client_id'), 'test-app');
      if (url.endsWith('/device')) {
        assert.equal(body.has('client_secret'), false);
        assert.equal(body.get('scope'), 'media:read');
        return Response.json({
          device_code: 'private-device-code',
          user_code: 'ABCD-EFGH',
          expires_in: 900,
          interval: 5,
        });
      }
      assert.equal(body.get('client_secret'), 'test-secret');
      if (url.endsWith('/revoke')) {
        assert.equal(body.get('token'), 'private-refresh-token');
        revoked = true;
        return new Response(null, { status: 200 });
      }
      if (body.get('grant_type') === 'refresh_token') {
        assert.equal(body.get('refresh_token'), 'private-refresh-token');
        refreshed++;
        return Response.json({
          access_token: 'refreshed-token',
          refresh_token: 'private-refresh-token',
          expires_in: 3600,
        });
      }
      assert.equal(body.get('device_code'), 'private-device-code');
      if (!approved)
        return Response.json(
          { error: 'authorization_pending' },
          { status: 400 }
        );
      return Response.json({
        access_token: 'private-access-token',
        refresh_token: 'private-refresh-token',
        expires_in: 3600,
      });
    }
  );

  const display = await SimklConnection.start('owner', 'viewer');
  assert.equal(display.code, 'ABCD-EFGH');
  assert.equal(new URL(display.url).hostname, 'simkl.com');
  assert.doesNotMatch(JSON.stringify(display), /private|test-secret/);
  await assert.rejects(SimklConnection.poll('owner', ''), /expired/);
  assert.equal(
    (await SimklConnection.poll('owner', 'viewer')).connected,
    false
  );
  assert.equal(mockFetch.mock.callCount(), 1);
  now += 5001;
  assert.equal(
    (await SimklConnection.poll('owner', 'viewer')).connected,
    false
  );
  approved = true;
  now += 5001;
  assert.deepEqual(await SimklConnection.poll('owner', 'viewer'), {
    connected: true,
  });
  const grant = await SimklConnection.grantId('owner', 'viewer');
  assert.ok(grant);
  assert.equal(await SimklConnection.grantId('owner', ''), undefined);
  assert.equal(await SimklConnection.grantId('other', 'viewer'), undefined);
  const row = await db.maybeOne<{ credentials: string }>(
    sql`SELECT credentials FROM simkl_connections`
  );
  assert.ok(row?.credentials);
  assert.doesNotMatch(
    row.credentials,
    /private-access-token|private-refresh-token/
  );
  assert.equal(
    await SimklConnection.accessToken('owner', 'viewer', grant),
    'private-access-token'
  );
  now += 3600000;
  assert.deepEqual(
    await Promise.all([
      SimklConnection.accessToken('owner', 'viewer', grant),
      SimklConnection.accessToken('owner', 'viewer', grant),
    ]),
    ['refreshed-token', 'refreshed-token']
  );
  assert.equal(refreshed, 1);
  await SimklConnection.disconnect('owner', 'viewer');
  assert.equal(revoked, true);
  assert.equal(await SimklConnection.grantId('owner', 'viewer'), undefined);
  assert.equal(
    await SimklConnection.accessToken('owner', 'viewer', grant),
    undefined
  );
});
