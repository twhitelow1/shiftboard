// Vercel Function entry point. vercel.json rewrites /api/* here; the web app itself
// is static (dist/) and served by Vercel's CDN.
//
// One deployment serves every restaurant on the platform (server/platform/): the host picks the
// restaurant. Without PLATFORM_DOMAIN every host is the default restaurant, exactly as before.
import '../server/tz.js';
import { createPlatformApp } from '../server/platform/index.js';
import { openConnection } from '../server/db.js';

const app = createPlatformApp({ conn: openConnection() });

// Start connecting during the cold start. If it fails, the first request retries and
// returns a clear 503 instead of crashing the function.
app.locals.warmDefault().catch(() => {});

export default app;
