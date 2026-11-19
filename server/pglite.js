// Embedded Postgres for local development and tests (no install needed).
// PGlite is a single connection, so a mutex gives each transaction exclusive use of it,
// which matches what a pg.Pool client gets from a real server.
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export async function openPglite(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;

  let tail = Promise.resolve();
  const acquire = () => {
    let release;
    const held = new Promise((r) => (release = r));
    const ready = tail.then(() => release);
    tail = tail.then(() => held);
    return ready;
  };
  const query = (text, params) => db.query(text, params);

  return {
    async query(text, params) {
      const release = await acquire();
      try { return await query(text, params); } finally { release(); }
    },
    async connect() {
      const release = await acquire();
      return { query, release: () => release() };
    },
    end: () => db.close(),
  };
}
