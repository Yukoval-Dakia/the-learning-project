// LOCAL ONLY, never committed (excluded via .git/info/exclude). Loft preview: /api goes to the
// ISOLATED COPY app on 127.0.0.1:8817 — never the real app on :8787.
import { mergeConfig } from 'vite';
import base from './vite.config';
export default mergeConfig(base, {
  server: { proxy: { '/api': 'http://127.0.0.1:8817' } },
  preview: { host: '192.168.50.216', port: 8811, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8817' } },
});
