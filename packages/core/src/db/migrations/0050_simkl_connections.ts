import type { Migration } from './types.js';

const ddl = `
  CREATE TABLE IF NOT EXISTS simkl_connections (
    uuid TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
    variant TEXT NOT NULL,
    client_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    credentials TEXT NOT NULL,
    PRIMARY KEY (uuid, variant)
  );
`;

export const simklConnections: Migration = {
  id: 50,
  name: 'simkl_connections',
  up: { sqlite: ddl, postgres: ddl },
};
