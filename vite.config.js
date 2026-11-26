import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const DEMO = process.env.DEMO === '1';
const page = (p) => fileURLToPath(new URL(p, import.meta.url));

// The demo is one self-contained file with no server: no manifest, icons or service worker (web/public).
const demoWithoutAppFiles = {
  name: 'demo-without-app-files',
  transformIndexHtml: (html) => html.replace(/\s*<link rel="(manifest|apple-touch-icon)"[^>]*>/g, ''),
};

export default defineConfig({
  root: 'web',
  publicDir: DEMO ? false : 'public',
  plugins: [react(), ...(DEMO ? [viteSingleFile(), demoWithoutAppFiles] : [])],
  // __APP_VERSION__: the commit being built (Vercel sets VERCEL_GIT_COMMIT_SHA), sent with error reports.
  define: { __DEMO__: JSON.stringify(DEMO), __APP_VERSION__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev') },
  build: {
    outDir: DEMO ? '../dist-demo' : '../dist',
    emptyOutDir: true,
    target: 'es2020',
    // The hosted build has two pages: the app, and the platform console for DubLow staff (platform.html,
    // web/console/). The demo is the app alone.
    ...(DEMO ? {} : { rolldownOptions: { input: { main: page('./web/index.html'), platform: page('./web/platform.html') } } }),
  },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
