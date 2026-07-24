// M1-T5 (YUK-314) — boss worker 启动配方，从 scripts/worker.ts 抽出共享：
// scripts/worker.ts（独立 worker 进程，prod/NAS docker 拓扑）与 server/index.ts
// （RW_WORKER=1 进程内 worker，新栈 dev 单进程拓扑）共用同一配方，YUK-259 的
// 两段 23505 防护不维护两份。进程级 last-resort handler（unhandledRejection →
// exit(1)）是独立 worker 进程的纪律，留在 scripts/worker.ts，不属于这里。

import type { PgBoss } from 'pg-boss';

import { capabilities } from '@/capabilities';
import type { Db } from '@/db/client';
import { createBoss, isQueueCreateRace, markBossStarted } from '@/server/boss/client';
import { registerHandlers } from '@/server/boss/handlers';
import { reconcileStuckAiTaskRuns } from '@/server/boss/handlers/ai_task_run_reconcile';
import { registerCapabilityJobs } from '@/server/boss/register-capability-jobs';
import { mountSubscriptionDispatch } from '@/server/event-subscriptions/dispatch-mount';
import { hydrateSubjectRegistryFromDb, startSubjectRefresh } from '@/server/subjects/hydrate';

export async function startBossWorker(db: Db): Promise<PgBoss> {
  // YUK-599（v2 §4）— worker 首个 job 落地前水合 SubjectRegistry（never-throws：
  // hydrate 内部 WARN + 代码种子地板，绝不挡 worker boot）。
  await hydrateSubjectRegistryFromDb(db);
  // F-2 (YUK-185) / PR #232 review (FIX #6) — the brief regen handler calls the
  // LLM via runTask, which needs XIAOMI_API_KEY (resolveTaskProvider throws
  // otherwise, providers.ts:88). Surface a missing key at BOOT — not per-scope
  // at 3 AM and not inside registerMemoryHandlers (which tests also call).
  // One-shot WARN; not fatal: ingest/outbox handlers still run and brief regen
  // degrades to a logged-skip per scope (F-1/D8).
  if (!process.env.XIAOMI_API_KEY) {
    console.warn(
      '[worker] XIAOMI_API_KEY unset — memory brief regen will fail (logged-skip per scope, F-1/D8)',
    );
  }

  const boss = createBoss();

  // YUK-259: pg-boss is an EventEmitter; it emits `error` for failures raised by
  // its INTERNAL background loops (timekeeper / supervise / maintenance) — e.g.
  // the timekeeper creating its `__pgboss__send-it` queue at start. With NO
  // `error` listener, Node's EventEmitter rethrows an emitted `error`, which a
  // process-level uncaughtException handler turns into exit(1). During a
  // cold start where the app's in-process boss and this worker race to create
  // the same queues, that internal create can raise a benign 23505 `queue_pkey`
  // (`Key (name)=(__pgboss__send-it) already exists`) — which used to crash the
  // worker (the queue already exists; restarting "fixed" it). Swallow that
  // benign race here and log everything else loudly. We do NOT exit on a logged
  // error: a transient supervise-loop hiccup shouldn't kill a worker that is
  // otherwise draining the queue; genuine fatal faults still surface via the
  // entrypoint's unhandledRejection / uncaughtException guards.
  boss.on('error', (err) => {
    if (isQueueCreateRace(err)) {
      console.warn(
        '[worker] pg-boss internal queue create race (23505 queue_pkey) — benign, queue already exists (YUK-259)',
      );
      return;
    }
    console.error('[worker] pg-boss error event', err);
  });

  // YUK-259: the boss `error` listener above only covers pg-boss's RECURRING
  // background loops (timekeeper onCron / cacheClockSkew at timekeeper.js:105/129,
  // which wrap their bodies in try/catch and re-emit on `error`). It does NOT
  // cover the one-shot queue create the timekeeper runs INSIDE start():
  // index.js start() → timekeeper.start() (timekeeper.js:57) directly awaits
  // `manager.createQueue('__pgboss__send-it')`, whose `INSERT ... ON CONFLICT DO
  // NOTHING` (plans.js create_queue) can still race-raise 23505 `queue_pkey`
  // under the same cold-start contention. That rejection propagates out of the
  // awaited start() — not through the EventEmitter — so without this guard it
  // would fall through to the caller's catch → process.exit(1), reopening the
  // supervised-restart loop YUK-259 set out to close. A 23505 here means SEND_IT
  // already exists (the desired end state) and the db is already opened
  // (index.js opens it before timekeeper.start), so the boss is usable;
  // swallow + continue. Anything else is a real boot failure and re-throws.
  try {
    await boss.start();
  } catch (err) {
    if (!isQueueCreateRace(err)) throw err;
    console.warn(
      '[worker] boss.start() hit pg-boss internal SEND_IT queue create race (23505 queue_pkey) — benign, queue already exists, continuing (YUK-259)',
    );
  }
  // Mark this started boss as the running instance so getRunningBoss() can peek it in
  // the worker — otherwise the YUK-384 FULL mutation-wake + continuation dispatch are
  // inert here (the worker never calls getStartedBoss, which is what app processes use
  // to record the running boss). Both branches above leave `boss` usable.
  markBossStarted(boss);
  await registerHandlers(boss, db);
  // M4-T3 (YUK-319)：渐缩簿之后挂载各 capability manifest 声明的 job（建队 +
  // work + cron schedule）。顺序约定：簿先、注册器后——簿里的链式目标
  // （note_verify）先 ready，注册器再挂链式源。
  await registerCapabilityJobs(boss, db, capabilities);
  // YUK-751 (review TcWGF)：给持久订阅总线通电——注册器之后挂一个周期 pg-boss job 驱动
  // runSubscriptionDispatchCycle（registry 在此一次性加载）。checkpoint lease 跨 worker 串行化，
  // 故 in-process 与独立 worker 同时挂载无冲突；无任何 capability 声明订阅时挂载器直接 no-op。
  await mountSubscriptionDispatch(boss, db, capabilities);
  // YUK-599（v2 §4.3 可见性 SLA）— worker ≤60s 解析到新装配：60s 周期全量
  // reconcile（level-triggered 承重路径，判词 B）。unref 不阻退出；SIGTERM →
  // installShutdownHandler → boss.stop() → 'stopped' → 显式清定时器（v2-test-9）。
  const refresh = startSubjectRefresh(db, 60_000);
  boss.once('stopped', () => refresh.stop());
  // YUK-576 §5.4 — boot-time stuck-run reconcile (PRIMARY trigger): the main
  // stuck cause is a process crash, so the restart converges >1h 'running'
  // ai_task_runs rows within seconds (the 1h threshold guards the previous
  // process's youngest runs). The nightly cron (observability manifest,
  // ai_task_run_reconcile_nightly) is the secondary trigger for DB-outage-type
  // stuck rows where no restart happens. Best-effort: a sweep failure must
  // never abort worker boot — the queue-draining duty comes first.
  try {
    await reconcileStuckAiTaskRuns(db);
  } catch (err) {
    console.error('[worker] boot-time stuck-run reconcile failed (non-fatal)', err);
  }
  return boss;
}
