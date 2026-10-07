import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, '../..'),
  base: '/_build/',
  plugins: [
    tanstackStart({
      srcDirectory: 'server/start',
      router: { basepath: '/' },
      sitemap: { enabled: false },
    }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { '@': resolve(import.meta.dirname, '../../src') } },
  // Keep the fetch-style server self-contained for the existing Node/Compose image.
  ssr: { noExternal: true },
  build: { outDir: 'dist/start' },
});
