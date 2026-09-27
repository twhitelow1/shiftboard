import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const DEMO = process.env.DEMO === '1';

export default defineConfig({
  root: 'web',
  plugins: [react(), ...(DEMO ? [viteSingleFile()] : [])],
  define: { __DEMO__: JSON.stringify(DEMO) },
  build: {
    outDir: DEMO ? '../dist-demo' : '../dist',
    emptyOutDir: true,
    target: 'es2020',
  },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
