// Shared by scripts/worker.ts and the in-process RW_WORKER path, so the 23505 guards live once.
// The process-level unhandledRejection exit stays in scripts/worker.ts.

import type { PgBoss } from 'pg-boss';
import { capabilities } from '@/capabilities';
import type { Db } from '@/db/client';
import { recoverToolOperationsOnBoot } from '@/kernel/tools/tool-operations';
import { initializeLaminarTracing } from '@/server/ai/laminar-tracing';
import {
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  hydrateModelCatalog,
  refreshModelCatalog,
  startModelCatalogWatch,
} from '@/server/ai/model-catalog';
import { resolveTaskProvider } from '@/server/ai/providers';
import { createBoss, isQueueCreateRace, markBossStarted } from '@/server/boss/client';
import { registerHandlers } from '@/server/boss/handlers';
import { reconcileStuckAiTaskRuns } from '@/server/boss/handlers/ai_task_run_reconcile';
import { registerCapabilityJobs } from '@/server/boss/register-capability-jobs';
import { sendVerifyDispatchStartupRecovery } from '@/server/boss/verify-dispatch-outbox';
import { hydrateConfigFromDb, startConfigRefresh } from '@/server/config/hydrate';
import { waitForRunnableEpoch } from '@/server/contract-epoch';
import { mountSubscriptionDispatch } from '@/server/event-subscriptions/dispatch-mount';
import { registerOrchestrator } from '@/server/orchestration/register';
import { hydrateSubjectRegistryFromDb, startSubjectRefresh } from '@/server/subjects/hydrate';

export type StartBossWorkerOptions = {
  /** Epoch-gate poll interval. Tests pass a short value. */
  epochPollIntervalMs?: number;
};

export async function startBossWorker(
  db: Db,
  options: StartBossWorkerOptions = {},
): Promise<PgBoss> {
  await initializeLaminarTracing();
  // Before any consumer. A maintenance marker or a mismatched epoch polls here and does not
  // start boss. A database read failure throws, same as any other boot failure.
  await waitForRunnableEpoch(db, { pollIntervalMs: options.epochPollIntervalMs });
  await recoverToolOperationsOnBoot(db);
  // Never throws. A hydrate failure warns and keeps the code seed, so boot continues.
  await hydrateSubjectRegistryFromDb(db);
  // Never throws. A missing table or a down database leaves an empty snapshot, which is env-only behavior.
  await hydrateConfigFromDb(db);
  await hydrateModelCatalog(db);
  // Validate the effective brief lane after config hydration, without a paid call.
  try {
    resolveTaskProvider('MemoryBriefTask');
  } catch (error) {
    console.warn(
      '[worker] memory brief provider configuration invalid',
      error instanceof Error ? error.message : 'unknown configuration error',
    );
  }

  const boss = createBoss();

  // pg-boss emits `error` from its background loops. With no listener, EventEmitter
  // rethrows and the process exits. A cold-start 23505 on an existing internal queue
  // is that race. Swallow it. Do not exit on other logged errors. A transient
  // supervise hiccup must not kill a worker that is still draining. On the standalone
  // worker, an uncaught rejection or exception still exits through the handlers in
  // scripts/worker.ts.
  boss.on('error', (err) => {
    if (isQueueCreateRace(err)) {
      console.warn(
        '[worker] pg-boss internal queue create race (23505 queue_pkey) — benign, queue already exists (YUK-259)',
      );
      return;
    }
    console.error('[worker] pg-boss error event', err);
  });

  // The listener above does not cover the queue create inside start(). That rejection
  // leaves the awaited call, not the EventEmitter. A 23505 means the internal send
  // queue already exists and the database is already open, so continue. Anything else rethrows.
  try {
    await boss.start();
  } catch (err) {
    if (!isQueueCreateRace(err)) throw err;
    console.warn(
      '[worker] boss.start() hit pg-boss internal SEND_IT queue create race (23505 queue_pkey) — benign, queue already exists, continuing (YUK-259)',
    );
  }
  // The worker never calls getStartedBoss. Without this mark, getRunningBoss() stays
  // empty and the mutation wake never fires. Both branches above leave boss usable.
  markBossStarted(boss);
  await registerHandlers(boss, db);
  // Infrastructure queues first. Manifest jobs create the domain queues this book sends to.
  await registerCapabilityJobs(boss, db, capabilities);
  // After the verifier queues exist. The recover worker is mounted earlier, so a send
  // before those queues exist throws and the drain waits for the nightly cron.
  await sendVerifyDispatchStartupRecovery(boss);
  // The checkpoint lease serializes workers, so the in-process and standalone workers can both mount.
  // No declared subscription means this is a no-op.
  await mountSubscriptionDispatch(boss, db, capabilities);
  // After the member queues exist, so a send has a queue. No members means no cron.
  await registerOrchestrator(boss, db, capabilities);
  // Level-triggered reconcile. unref so the timer does not hold the process. Cleared on stopped.
  const refresh = startSubjectRefresh(db, 60_000);
  boss.once('stopped', () => refresh.stop());
  // The worker has no config write path, so this window is how a new row arrives. unref.
  const configRefreshHandle = startConfigRefresh(db, 15_000);
  boss.once('stopped', () => configRefreshHandle.stop());
  try {
    const refreshed = await refreshModelCatalog(db);
    if (refreshed.outcome === 'stored') {
      console.info(
        `[worker] model catalog stored version=${refreshed.meta.version} at=${refreshed.meta.fetchedAt}`,
      );
    }
  } catch (err) {
    console.warn('[worker] model catalog refresh failed (non-fatal)', err);
  }
  const catalogRefresh = setInterval(() => {
    void refreshModelCatalog(db).catch((err) => {
      console.warn('[worker] model catalog refresh failed (non-fatal)', err);
    });
  }, MODEL_CATALOG_REFRESH_INTERVAL_MS);
  catalogRefresh.unref();
  // The refresh lock serializes writers. This watch reloads the row another
  // worker stored, so this process does not keep a stale merge in memory.
  const catalogWatch = startModelCatalogWatch(db);
  boss.once('stopped', () => {
    clearInterval(catalogRefresh);
    catalogWatch.stop();
  });
  // A crash is the usual reason a run stays 'running'. Restart converges those rows.
  // The nightly cron covers a database outage where nobody restarts. A sweep failure must not abort boot.
  try {
    await reconcileStuckAiTaskRuns(db);
  } catch (err) {
    console.error('[worker] boot-time stuck-run reconcile failed (non-fatal)', err);
  }
  return boss;
}
