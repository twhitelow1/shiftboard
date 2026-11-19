// Standalone server: local development, Docker, or any VPS.
// (On Vercel the entry point is api/index.js and the CDN serves the web app.)
import './tz.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createDatabase } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const db = createDatabase();
const app = createApp({ db, staticDir: path.join(__dirname, '..', 'dist') });

try {
  await app.locals.ready();
} catch (e) {
  console.error(`ShiftBoard could not start: ${e.message}`);
  process.exit(1);
}

app.listen(PORT, () => console.log(`ShiftBoard running on http://localhost:${PORT}`));
