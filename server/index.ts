// M0 (YUK-313) — 新栈 API 入口：loadEnv → 组合根挂载 → Hono serve。
// dev: `pnpm rw:api`（tsx watch）。prod 形态（standalone/docker）在 M5 拆除旧栈时定稿。
// M1-T5 (YUK-314)：RW_WORKER=1（rw:api 默认开）时同进程启动 pg-boss worker —— 新栈
// dev 是单进程拓扑（API + worker 一个进程），旧 worker（pnpm worker:dev）在 M1 期间
// 仍可独立运行（两者共用 startBossWorker 配方，队列层面共存无冲突）。

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

if (process.env.RW_WORKER === '1') {
  // db client / boss 在 loadEnv() 之后才能 import（模块顶层读 DATABASE_URL），
  // 所以走动态 import，不进文件头 import 区。
  void (async () => {
    const [{ db }, { startBossWorker }, { installShutdownHandler }] = await Promise.all([
      import('@/db/client'),
      import('@/server/boss/start-worker'),
      import('@/server/boss/shutdown'),
    ]);
    const boss = await startBossWorker(db);
    installShutdownHandler(boss);
    console.log('[rw:api] in-process pg-boss worker running (RW_WORKER=1)');
  })().catch((err) => {
    // worker 起不来不该拖死 API 面：日志醒目 + API 继续服务（上传仍可用，
    // 只是 job 不被消费）；dev 下看到这条就修。
    console.error('[rw:api] in-process worker failed to start — jobs will NOT be consumed', err);
  });
}
