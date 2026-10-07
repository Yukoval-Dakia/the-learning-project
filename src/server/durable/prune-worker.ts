import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import type { JobDecl } from '@/kernel/manifest';
import { FAST_QUEUE_OPTS, createOrUpdateQueue } from '@/server/boss/queue-config';
import { waitForRunnableEpoch } from '@/server/contract-epoch';
import {
  PRUNE_DBOS_SCHEMA,
  PRUNE_FAMILY,
  commitPrune,
  drainLegacyPrune,
  installPruneProducerFence,
  readPrunePhase,
} from './prune-family';

export type PruneBoundary = 'business-committed' | 'checkpoint-saved';
export function registerPruneWorkflow(
  db: Db,
  boundary: (name: PruneBoundary) => Promise<void> = async () => {},
) {
  return DBOS.registerWorkflow(
    async (scheduledDate: Date, _context: unknown): Promise<void> => {
      const workflowId = DBOS.workflowID;
      if (!workflowId) throw new Error('Prune requires a durable workflow identity');
      const cutoff = new Date(scheduledDate.getTime() - 30 * 86400 * 1000);
      await DBOS.runStep(
        async () => {
          await waitForRunnableEpoch(db);
          await commitPrune(db, workflowId, cutoff);
          await boundary('business-committed');
        },
        { name: 'prune-business-commit', retriesAllowed: false },
      );
      await boundary('checkpoint-saved');
    },
    { name: PRUNE_FAMILY },
  );
}

let shutdown: (() => Promise<void>) | undefined;
type PruneWorkerOptions = {
  boss: PgBoss;
  db: Db;
  decl: JobDecl;
  boundary?: (name: PruneBoundary) => Promise<void>;
  reconcileIntervalMs?: number;
};
let registration:
  | { boss: PgBoss; promise: Promise<ReturnType<typeof registerPruneWorkflow>> }
  | undefined;
export async function stopDurableWorker(): Promise<number> {
  const stop = shutdown;
  if (!stop) return 0;
  shutdown = undefined;
  const started = performance.now();
  try {
    await stop();
  } finally {
    registration = undefined;
  }
  return Math.ceil(performance.now() - started);
}
export async function startPruneWorker(options: PruneWorkerOptions) {
  if (registration) {
    if (registration.boss !== options.boss)
      throw new Error('One DBOS owner is allowed per process');
    return registration.promise;
  }
  const promise = mountPruneWorker(options);
  registration = { boss: options.boss, promise };
  try {
    return await promise;
  } catch (error) {
    registration = undefined;
    throw error;
  }
}

async function mountPruneWorker({
  boss,
  db,
  decl,
  boundary,
  reconcileIntervalMs = 15000,
}: PruneWorkerOptions) {
  if (!decl.schedule || decl.name !== PRUNE_FAMILY || decl.queue !== 'fast')
    throw new Error('Invalid admitted prune declaration');
  if (shutdown) throw new Error('DBOS prune worker is already mounted');
  await createOrUpdateQueue(boss, PRUNE_FAMILY, FAST_QUEUE_OPTS);
  await installPruneProducerFence(db);
  const workflow = registerPruneWorkflow(db, boundary);
  DBOS.setConfig({
    name: 'tlp-housekeeping',
    systemDatabaseUrl: process.env.DATABASE_URL,
    systemDatabaseSchemaName: PRUNE_DBOS_SCHEMA,
    executorID: 'local',
    applicationVersion: 'prune-v1',
    systemDatabasePoolSize: 3,
    enableOTLP: false,
    tracingEnabled: false,
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let mounted = false;
  let stopping = false;
  let pending = Promise.resolve();
  shutdown = async () => {
    stopping = true;
    clearInterval(timer);
    await pending;
    await DBOS.shutdown({ workflowCompletionTimeoutMS: 3000 });
  };
  try {
    await DBOS.launch();
    const schedule = decl.schedule;
    const reconcile = async () => {
      if (stopping) return;
      await db.transaction(async (tx) => {
        // SHARE allows pg-boss's producer trigger to read the same row. Transitions
        // take UPDATE and therefore cannot race a stale cron registration.
        await tx.execute(sql`select phase from prune_job_events_control for share`);
        const phase = await readPrunePhase(tx);
        if (phase === 'dbos') {
          await boss.unschedule(PRUNE_FAMILY);
          await DBOS.applySchedules([
            {
              scheduleName: PRUNE_FAMILY,
              workflowFn: workflow,
              schedule: schedule.cron,
              cronTimezone: schedule.tz,
              automaticBackfill: false,
            },
          ]);
          await DBOS.resumeSchedule(PRUNE_FAMILY);
        } else if (await DBOS.getSchedule(PRUNE_FAMILY)) {
          await DBOS.pauseSchedule(PRUNE_FAMILY);
        }
        if (phase === 'pg-boss' || phase === 'draining-pg-boss') {
          if (!mounted) {
            await boss.work(PRUNE_FAMILY, { pollingIntervalSeconds: 2, batchSize: 1 }, async () => {
              await waitForRunnableEpoch(db);
              await drainLegacyPrune(db);
            });
            mounted = true;
          }
        } else if (mounted) {
          await boss.offWork(PRUNE_FAMILY, { wait: false });
          mounted = false;
        }
        if (phase === 'pg-boss')
          await boss.schedule(PRUNE_FAMILY, schedule.cron, {}, { tz: schedule.tz });
        else await boss.unschedule(PRUNE_FAMILY);
      });
    };
    await reconcile();
    timer = setInterval(() => {
      pending = pending.then(reconcile).catch((error: unknown) => {
        console.error('[prune_job_events] backend reconciliation failed', error);
      });
    }, reconcileIntervalMs);
    timer.unref();
    return workflow;
  } catch (error) {
    await stopDurableWorker();
    throw error;
  }
}
