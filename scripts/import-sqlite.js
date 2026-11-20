// One-time move from the old SQLite-based ShiftBoard (Render / Docker volume) to Postgres.
//
//   DATABASE_URL=postgres://... node scripts/import-sqlite.js /path/to/shiftboard.db [--replace]
//
// Copies every document (users, shifts, events, settings, ...). Refuses to touch a
// Postgres database that already has data unless --replace is given, in which case the
// existing documents are deleted first. Needs Node 22.5+ (node:sqlite).
import { DatabaseSync } from 'node:sqlite';
import { createDatabase, databaseUrl, SCHEMA } from '../server/db.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const replace = args.includes('--replace');

if (!file) {
  console.error('Usage: DATABASE_URL=postgres://... node scripts/import-sqlite.js /path/to/shiftboard.db [--replace]');
  process.exit(1);
}
if (!databaseUrl()) {
  console.error('Set DATABASE_URL (or POSTGRES_URL) to the Postgres database to import into.');
  process.exit(1);
}

const sqlite = new DatabaseSync(file, { readOnly: true });
const rows = sqlite.prepare('SELECT col, id, data FROM docs').all();
sqlite.close();
console.log(`Read ${rows.length} documents from ${file}`);

const db = createDatabase();
try {
  await db.migrate();
  const { rows: [{ n: existing }] } = await db.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.docs WHERE NOT deleted`);
  if (existing && !replace) {
    console.error(`The Postgres database already has ${existing} documents. Re-run with --replace to overwrite them.`);
    process.exit(1);
  }

  await db.withLock(async (client) => {
    if (replace) {
      // Tombstone instead of DELETE so running app instances drop their cached copies.
      await client.query(`UPDATE ${SCHEMA}.docs SET deleted = true, data = NULL, seq = nextval('${SCHEMA}.docs_seq'), updated_at = now() WHERE NOT deleted`);
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await db.writeDocs(client, rows.slice(i, i + 1000).map((r) => ({ col: r.col, id: r.id, doc: JSON.parse(r.data) })));
    }
  });

  const counts = (await db.query(`SELECT col, count(*)::int AS n FROM ${SCHEMA}.docs WHERE NOT deleted GROUP BY col ORDER BY col`)).rows;
  console.log('Imported:', counts.map((c) => `${c.col} ${c.n}`).join(', '));
  console.log('Tip: set JWT_SECRET on the new deployment to the old server\'s secret (its JWT_SECRET, or the DATA_DIR/.secret file) so existing calendar links keep working.');
} finally {
  await db.close();
}
