// M0 (YUK-313) — 新栈 API 入口：loadEnv → 组合根挂载 → Hono serve。
// dev: `pnpm rw:api`（tsx watch）。prod 形态（standalone/docker）在 M5 拆除旧栈时定稿。

import { capabilities } from '@/capabilities';
import { serve } from '@hono/node-server';
import { buildHonoApp } from './app';
import { loadEnv } from './env';

loadEnv();

const port = Number(process.env.API_PORT ?? 8787);
const app = buildHonoApp(capabilities);

serve({ fetch: app.fetch, port }, (info) => {
  const mounted = capabilities.flatMap((c) =>
    (c.api?.routes ?? []).filter((r) => r.load).map((r) => `${r.method} ${r.path}`),
  );
  console.log(`[rw:api] hono listening on :${info.port}`);
  console.log(`[rw:api] mounted from manifests: ${mounted.join(', ') || '(none)'}`);
});
