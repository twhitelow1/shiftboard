import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const DEMO = process.env.DEMO === '1';

// The demo is one self-contained file with no server: no manifest, icons or service worker (web/public).
const demoWithoutAppFiles = {
  name: 'demo-without-app-files',
  transformIndexHtml: (html) => html.replace(/\s*<link rel="(manifest|apple-touch-icon)"[^>]*>/g, ''),
};

export default defineConfig({
  root: 'web',
  publicDir: DEMO ? false : 'public',
  plugins: [react(), ...(DEMO ? [viteSingleFile(), demoWithoutAppFiles] : [])],
  define: { __DEMO__: JSON.stringify(DEMO) },
  build: {
    outDir: DEMO ? '../dist-demo' : '../dist',
    emptyOutDir: true,
    target: 'es2020',
  },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
