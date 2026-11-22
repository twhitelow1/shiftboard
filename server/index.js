// Standalone server: local development, Docker, or any VPS.
// (On Vercel the entry point is api/index.js and the CDN serves the web app.)
// Serves every restaurant on the platform by host (server/platform/); without PLATFORM_DOMAIN,
// every host is the default restaurant.
import './tz.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlatformApp } from './platform/index.js';
import { openConnection } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = createPlatformApp({ conn: openConnection(), staticDir: path.join(__dirname, '..', 'dist') });

try {
  await app.locals.warmDefault();
} catch (e) {
  console.error(`ShiftBoard could not start: ${e.message}`);
  process.exit(1);
}

app.listen(PORT, () => console.log(`ShiftBoard running on http://localhost:${PORT}`));
