// Vercel Function entry point. vercel.json rewrites /api/* here; the web app itself
// is static (dist/) and served by Vercel's CDN.
import '../server/tz.js';
import { createApp } from '../server/app.js';
import { createDatabase } from '../server/db.js';

const app = createApp({ db: createDatabase() });

// Start connecting during the cold start. If it fails, the first request retries and
// returns a clear 503 instead of crashing the function.
app.locals.ready().catch(() => {});

export default app;
