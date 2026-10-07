import { resolve } from 'node:path';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, '../..'),
  plugins: [
    tanstackStart({
      srcDirectory: 'server/start',
      sitemap: { enabled: false },
    }),
    react(),
  ],
  resolve: { alias: { '@': resolve(import.meta.dirname, '../../src') } },
  // Keep the fetch-style server self-contained for the existing Node/Compose image.
  ssr: { noExternal: true },
  build: { outDir: 'dist/start' },
});
