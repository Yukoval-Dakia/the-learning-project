// Dev-only loft server. Not referenced by `pnpm build`; the production SPA root is web/.
// Run: pnpm exec vite --config docs/design/2026-10-07-visual-loft/prototype/vite.config.mjs
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, '../../../..')] },
  },
});
