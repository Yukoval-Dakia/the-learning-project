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
import { createBoss, isQueueCreateRace } from '@/server/boss/client';
import { registerHandlers } from '@/server/boss/handlers';
import { installShutdownHandler } from '@/server/boss/shutdown';

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
// cover the whole process lifetime including registerHandlers() itself.
process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandledRejection — exiting for supervised restart', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaughtException — exiting for supervised restart', err);
  process.exit(1);
});

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

  // YUK-259: pg-boss is an EventEmitter; it emits `error` for failures raised by
  // its INTERNAL background loops (timekeeper / supervise / maintenance) — e.g.
  // the timekeeper creating its `__pgboss__send-it` queue at start. With NO
  // `error` listener, Node's EventEmitter rethrows an emitted `error`, which the
  // process-level uncaughtException handler above turns into exit(1). During a
  // cold start where the app's in-process boss and this worker race to create
  // the same queues, that internal create can raise a benign 23505 `queue_pkey`
  // (`Key (name)=(__pgboss__send-it) already exists`) — which used to crash the
  // worker (the queue already exists; restarting "fixed" it). Swallow that
  // benign race here and log everything else loudly. We do NOT exit on a logged
  // error: a transient supervise-loop hiccup shouldn't kill a worker that is
  // otherwise draining the queue; genuine fatal faults still surface via the
  // unhandledRejection / uncaughtException guards above.
  boss.on('error', (err) => {
    if (isQueueCreateRace(err)) {
      console.warn(
        '[worker] pg-boss internal queue create race (23505 queue_pkey) — benign, queue already exists (YUK-259)',
      );
      return;
    }
    console.error('[worker] pg-boss error event', err);
  });

  await boss.start();
  await registerHandlers(boss, db);
  installShutdownHandler(boss);
  console.log('[worker] running, handlers registered');
}

main().catch((err) => {
  console.error('[worker] startup failed', err);
  process.exit(1);
});
