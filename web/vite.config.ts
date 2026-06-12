// M0 (YUK-313) — 新栈前端工程（Vite SPA）。root = web/；'@' 别名与 tsconfig 对齐
// 指向 ../src（capability ui 资产直接复用）；dev 经 proxy 打 Hono(:8787)。
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, '.'),
  plugins: [react(), tailwindcss()],
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
