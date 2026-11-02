import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const optionalDbosLoggers = ['winston', 'winston-transport'];

export default defineConfig(({ command }) => ({
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
  // The build keeps the fetch-style server self-contained for the Node/Compose image; the dev
  // server (server/dev-frontdoor.ts) leaves node_modules external so CJS deps load natively.
  ssr:
    command === 'build'
      ? { noExternal: true, external: optionalDbosLoggers }
      : { external: optionalDbosLoggers },
  environments: {
    ssr: { build: { rolldownOptions: { external: optionalDbosLoggers } } },
  },
  build: { outDir: 'dist/start' },
}));
