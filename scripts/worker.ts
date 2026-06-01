// pg-boss worker entrypoint —— 独立进程，与 Next.js app 进程解耦。
//
// 启动方式：`pnpm worker:dev`（tsx）或 docker container 用 `node dist/scripts/worker.js`。
//
// 与 app process 的区别：
//   - app process 启 instrumentation.ts → startListenLoop（消费 NOTIFY → SSE 推送）
//   - worker process **不**启 listen loop（自己发出的 NOTIFY 不必自己消费）
//   - worker process 只跑 pg-boss handlers（boss.work），handler 内部写 DB + NOTIFY
//
// 当前共用 DATABASE_URL；生产可独立配 R2/ANTHROPIC env，pg-boss 在
// `pgboss.*` schema 自动建出。

import { db } from '@/db/client';
import { createBoss } from '@/server/boss/client';
import { registerHandlers } from '@/server/boss/handlers';
import { installShutdownHandler } from '@/server/boss/shutdown';

async function main() {
  // F-2 (YUK-185) / PR #232 review (FIX #6) — the brief regen handler calls the
  // LLM via runTask, which needs XIAOMI_API_KEY (resolveTaskProvider throws
  // otherwise, providers.ts:88). Surface a missing key at BOOT here — the prod
  // worker entry point that actually runs the cron — not per-scope at 3 AM and
  // not inside registerMemoryHandlers (which tests also call). One-shot WARN;
  // not fatal: ingest/outbox handlers still run and brief regen degrades to a
  // logged-skip per scope (F-1/D8).
  if (!process.env.XIAOMI_API_KEY) {
    console.warn(
      '[worker] XIAOMI_API_KEY unset — memory brief regen will fail (logged-skip per scope, F-1/D8)',
    );
  }

  const boss = createBoss();
  await boss.start();
  await registerHandlers(boss, db);
  installShutdownHandler(boss);
  console.log('[worker] running, handlers registered');
}

main().catch((err) => {
  console.error('[worker] startup failed', err);
  process.exit(1);
});
