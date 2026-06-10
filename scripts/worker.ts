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
//
// M1-T5 (YUK-314)：启动配方（XIAOMI warn + YUK-259 两段 23505 防护 +
// registerHandlers）抽到 src/server/boss/start-worker.ts，与新栈
// server/index.ts 的 RW_WORKER=1 进程内 worker 共用。本文件只剩独立进程
// 专属纪律：process-level last-resort handlers + shutdown 安装。

import { db } from '@/db/client';
import { installShutdownHandler } from '@/server/boss/shutdown';
import { startBossWorker } from '@/server/boss/start-worker';

// YUK-235 [STB-1]: process-level last-resort handlers. Before this, the only
// guard was `main().catch(...)` below, which catches a rejected boot promise but
// NOT errors thrown after boot — once pg-boss handlers are registered, an
// unhandled rejection (e.g. an `await` with no catch deep in a handler chain, or
// a stray event-emitter error) or a synchronous uncaughtException would, under
// Node's default, log a deprecation warning and (for uncaughtException) crash
// with a non-deterministic exit code, leaving the worker in an undefined state.
// We log + exit(1) so the container's restart policy (docker-compose) gives us a
// clean, supervised restart instead of a zombie worker that stops draining the
// queue silently. Registered once, at the very top of the entrypoint, so they
// cover the whole process lifetime including startBossWorker() itself.
process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandledRejection — exiting for supervised restart', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaughtException — exiting for supervised restart', err);
  process.exit(1);
});

async function main() {
  const boss = await startBossWorker(db);
  installShutdownHandler(boss);
  console.log('[worker] running, handlers registered');
}

main().catch((err) => {
  console.error('[worker] startup failed', err);
  process.exit(1);
});
