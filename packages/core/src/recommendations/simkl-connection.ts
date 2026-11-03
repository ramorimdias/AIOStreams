import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bootstrap } from '../config/bootstrap.js';
import { getDb } from '../db/db.js';
import { sql } from '../db/sql.js';
import { decryptString, encryptString } from '../utils/crypto.js';
import { Cache } from '../utils/cache.js';

const deviceResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
});
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const credentialSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});

type DeviceFlow = {
  deviceCode: string;
  clientId: string;
  interval: number;
  nextPoll: number;
  expiresAt: number;
  polling: boolean;
};
const flows = Cache.getInstance<string, DeviceFlow>(
  'simkl_device_flow',
  1000,
  'memory',
  { clone: false }
);
const refreshing = new Map<string, Promise<string | undefined>>();

function scopeKey(uuid: string, variant: string) {
  return JSON.stringify([uuid, variant]);
}

function seal(value: z.infer<typeof credentialSchema>): string {
  const result = encryptString(JSON.stringify(value));
  if (!result.success)
    throw new Error('Could not encrypt the Simkl connection.');
  return result.data;
}

function tokenData(raw: unknown) {
  const data = tokenResponse.parse(raw);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function request(
  path: 'device' | 'token' | 'revoke',
  params: Record<string, string>
) {
  const clientId = bootstrap.simklClientId;
  if (!clientId) throw new Error('Simkl is not configured on this instance.');
  const body = new URLSearchParams({ client_id: clientId, ...params });
  if (path !== 'device' && bootstrap.simklClientSecret) {
    body.set('client_secret', bootstrap.simklClientSecret);
  }
  const response = await fetch('https://api.simkl.com/oauth2/' + path, {
    method: 'POST',
    headers: { 'User-Agent': 'AIOStreams' },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const data: unknown = await response.json().catch(() => null);
  const error = z.object({ error: z.string() }).safeParse(data);
  return {
    ok: response.ok,
    data,
    error: error.success ? error.data.error : undefined,
  };
}

export class SimklConnection {
  static configured() {
    return Boolean(bootstrap.simklClientId);
  }

  static async grantId(
    uuid: string,
    variant: string
  ): Promise<string | undefined> {
    if (!bootstrap.simklClientId) return;
    const row = await getDb().maybeOne<{ grant_id: string }>(
      sql`SELECT grant_id FROM simkl_connections WHERE uuid = ${uuid}
        AND variant = ${variant} AND client_id = ${bootstrap.simklClientId}`
    );
    return row?.grant_id;
  }

  static async start(uuid: string, variant: string) {
    const clientId = bootstrap.simklClientId;
    if (!clientId) throw new Error('Simkl is not configured on this instance.');
    const result = await request('device', { scope: 'media:read' });
    if (!result.ok) throw new Error('Simkl could not start authorization.');
    const response = deviceResponse.parse(result.data);
    const interval = response.interval * 1000;
    await flows.set(
      scopeKey(uuid, variant),
      {
        deviceCode: response.device_code,
        clientId,
        interval,
        nextPoll: Date.now() + interval,
        expiresAt: Date.now() + response.expires_in * 1000,
        polling: false,
      },
      response.expires_in
    );
    const url = new URL('https://simkl.com/pin');
    url.searchParams.set('user_code', response.user_code);
    return {
      code: response.user_code,
      url: url.toString(),
      interval,
      expiresIn: response.expires_in,
    };
  }

  static async poll(
    uuid: string,
    variant: string
  ): Promise<{ connected: boolean; retryIn?: number }> {
    const key = scopeKey(uuid, variant);
    const flow = await flows.get(key);
    if (
      !flow ||
      flow.expiresAt <= Date.now() ||
      flow.clientId !== bootstrap.simklClientId
    ) {
      throw new Error('The Simkl code expired. Start a new connection.');
    }
    if (flow.polling || flow.nextPoll > Date.now()) {
      return {
        connected: false,
        retryIn: Math.max(flow.interval, flow.nextPoll - Date.now()),
      };
    }
    flow.polling = true;
    try {
      const result = await request('token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode,
      });
      if ((await flows.get(key)) !== flow)
        throw new Error('The Simkl connection attempt was replaced.');
      if (
        result.error === 'authorization_pending' ||
        result.error === 'slow_down'
      ) {
        if (result.error === 'slow_down') flow.interval += 5000;
        return { connected: false, retryIn: flow.interval };
      }
      if (!result.ok) {
        await flows.delete(key);
        throw new Error('Simkl authorization failed. Start a new connection.');
      }
      const encrypted = seal(tokenData(result.data));
      await getDb()
        .exec(sql`INSERT INTO simkl_connections (uuid, variant, client_id, grant_id, credentials)
        VALUES (${uuid}, ${variant}, ${flow.clientId}, ${randomUUID()}, ${encrypted})
        ON CONFLICT (uuid, variant) DO UPDATE SET client_id = excluded.client_id,
          grant_id = excluded.grant_id, credentials = excluded.credentials`);
      await flows.delete(key);
      return { connected: true };
    } finally {
      flow.nextPoll = Date.now() + flow.interval;
      flow.polling = false;
    }
  }

  static async disconnect(uuid: string, variant: string) {
    await flows.delete(scopeKey(uuid, variant));
    const row = await getDb().maybeOne<{
      credentials: string;
      client_id: string;
      grant_id: string;
    }>(
      sql`SELECT credentials, client_id, grant_id FROM simkl_connections WHERE uuid = ${uuid} AND variant = ${variant}`
    );
    if (!row) return;
    await getDb().exec(
      sql`DELETE FROM simkl_connections WHERE uuid = ${uuid} AND variant = ${variant} AND grant_id = ${row.grant_id}`
    );
    if (row.client_id !== bootstrap.simklClientId) return;
    // Disconnect locally even if the provider cannot revoke the grant.
    const decrypted = decryptString(row.credentials);
    if (!decrypted.success) return;
    const stored = credentialSchema.safeParse(JSON.parse(decrypted.data));
    if (stored.success) {
      await request('revoke', {
        token: stored.data.refreshToken,
        token_type_hint: 'refresh_token',
      }).catch(() => undefined);
    }
  }

  static async accessToken(uuid: string, variant: string, grantId: string) {
    const current = refreshing.get(grantId);
    if (current) return current;
    const task = this.resolveToken(uuid, variant, grantId).finally(() =>
      refreshing.delete(grantId)
    );
    refreshing.set(grantId, task);
    return task;
  }

  private static async resolveToken(
    uuid: string,
    variant: string,
    grantId: string
  ) {
    const row = await getDb().maybeOne<{ credentials: string }>(
      sql`SELECT credentials FROM simkl_connections WHERE uuid = ${uuid}
        AND variant = ${variant} AND grant_id = ${grantId} AND client_id = ${bootstrap.simklClientId}`
    );
    if (!row) return;
    const decrypted = decryptString(row.credentials);
    if (!decrypted.success)
      throw new Error('Could not decrypt the Simkl connection.');
    const stored = credentialSchema.parse(JSON.parse(decrypted.data));
    if (stored.expiresAt > Date.now() + 60000) return stored.accessToken;
    const result = await request('token', {
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    });
    if (result.error === 'invalid_grant') {
      await getDb().exec(sql`DELETE FROM simkl_connections
        WHERE uuid = ${uuid} AND variant = ${variant} AND grant_id = ${grantId} AND credentials = ${row.credentials}`);
      return;
    }
    if (!result.ok) throw new Error('Simkl token refresh failed.');
    const updated = tokenData(result.data);
    await getDb()
      .exec(sql`UPDATE simkl_connections SET credentials = ${seal(updated)}
      WHERE uuid = ${uuid} AND variant = ${variant} AND grant_id = ${grantId} AND credentials = ${row.credentials}`);
    return updated.accessToken;
  }
}
