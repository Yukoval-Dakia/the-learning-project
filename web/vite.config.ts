// M0 (YUK-313) — 新栈前端工程（Vite SPA）。root = web/；'@' 别名与 tsconfig 对齐
// 指向 ../src（capability ui 资产直接复用）；dev 经 proxy 打 Hono(:8787)。
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Connect, type Plugin, defineConfig } from 'vite';

// LOFT ONLY (branch loft-ingest-progress, never merged): serve the ingest
// progress replay's real-paper fixture from a file OUTSIDE the repo, on the dev
// and preview servers only. Missing file → 404 → the replay uses placeholders.
const LOFT_INGEST_FIXTURE =
  process.env.TLP_INGEST_LOFT_FIXTURE ??
  '/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/ingest-loft-fixture.json';

function loftIngestFixture(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split('?')[0] !== '/__loft/ingest-fixture.json') return next();
    readFile(LOFT_INGEST_FIXTURE)
      .then((body) => {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(body);
      })
      .catch(() => {
        res.statusCode = 404;
        res.end();
      });
  };
  return {
    name: 'loft-ingest-fixture',
    configureServer: (server) => {
      server.middlewares.use(handler);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname, '.'),
  plugins: [react(), tailwindcss(), loftIngestFixture()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, '../src') },
  },
  server: {
    port: 5173,
    // M5-T5c (YUK-321)：旧栈已拆除，所有 /api 请求走 Hono(:8787)。
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: { outDir: 'dist' },
});
