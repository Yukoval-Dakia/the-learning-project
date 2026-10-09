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
  hasRecentDbosPruneReceipt,
  installPruneProducerFence,
  readPrunePhase,
} from './prune-family';
import {
  REVIEW_ORPHAN_FAMILY,
  type ReviewOrphanBoundaryHook,
  installReviewOrphanProducerFence,
} from './review-orphan-family';
import { createReviewOrphanBackend, registerReviewOrphanWorkflow } from './review-orphan-worker';

import { installSessionOrphanProducerFence } from './session-orphan-backend';
import type { SessionOrphanBoundaryHook } from './session-orphan-family';
import {
  createSessionOrphanBackend,
  registerSessionOrphanWorkflows,
} from './session-orphan-worker';

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

type PruneWorkerOptions = {
  boss: PgBoss;
  db: Db;
  decl: JobDecl;
  boundary?: (name: PruneBoundary) => Promise<void>;
  reconcileIntervalMs?: number;
};
export type DurableWorkerOptions = {
  boss: PgBoss;
  db: Db;
  declarations: {
    pruneEvents: JobDecl;
    reviewOrphans: JobDecl;
    conversationOrphans: JobDecl;
    placementOrphans: JobDecl;
  };
  boundary?: (name: PruneBoundary) => Promise<void>;
  reviewBoundary?: ReviewOrphanBoundaryHook;
  sessionBoundary?: SessionOrphanBoundaryHook;
  reconcileIntervalMs?: number;
};
type HostOptions = PruneWorkerOptions & {
  reviewDecl?: JobDecl;
  conversationDecl?: JobDecl;
  placementDecl?: JobDecl;
  reviewBoundary?: ReviewOrphanBoundaryHook;
  sessionBoundary?: SessionOrphanBoundaryHook;
};
type Host = {
  boss: PgBoss;
  db: Db;
  key: string;
  promise: Promise<ReturnType<typeof registerPruneWorkflow>>;
  shutdown?: () => Promise<void>;
  stopPromise?: Promise<number>;
};
let registration: Host | undefined;

function declarationKey(options: HostOptions) {
  for (const [decl, name] of [
    [options.decl, PRUNE_FAMILY],
    [options.reviewDecl, REVIEW_ORPHAN_FAMILY],
    [options.conversationDecl, 'prune_orphan_conversation_sessions'],
    [options.placementDecl, 'prune_orphan_placement_sessions'],
  ] as const) {
    if (!decl && name !== PRUNE_FAMILY) continue;
    if (
      !decl ||
      decl.name !== name ||
      decl.backend !== 'dbos' ||
      decl.queue !== 'fast' ||
      !decl.schedule ||
      !decl.schedule.cron.trim() ||
      !decl.schedule.tz.trim() ||
      decl.load ||
      decl.schedule.singletonKey !== undefined ||
      decl.schedule.singletonSeconds !== undefined
    )
      throw new Error(`Invalid admitted declaration ${name}`);
  }
  // Preserve prune-only fixtures; any later expansion or changed contract is explicit failure.
  return JSON.stringify(
    [options.decl, options.reviewDecl, options.conversationDecl, options.placementDecl].map(
      (decl) =>
        decl
          ? {
              name: decl.name,
              schedule: decl.schedule ? { cron: decl.schedule.cron, tz: decl.schedule.tz } : null,
            }
          : null,
    ),
  );
}

export async function stopDurableWorker(): Promise<number> {
  const host = registration;
  if (!host) return 0;
  if (!host.stopPromise)
    host.stopPromise = (async () => {
      const started = performance.now();
      try {
        await host.promise.catch(() => {});
        await host.shutdown?.();
      } finally {
        if (registration === host) registration = undefined;
      }
      return Math.ceil(performance.now() - started);
    })();
  return host.stopPromise;
}

function startHost(options: HostOptions) {
  const key = declarationKey(options);
  if (registration) {
    if (
      registration.boss !== options.boss ||
      registration.db !== options.db ||
      registration.key !== key ||
      registration.stopPromise
    )
      throw new Error(
        'DBOS host cannot change boss, database or admitted declarations after startup',
      );
    return registration.promise;
  }
  const host: Host = {
    boss: options.boss,
    db: options.db,
    key,
    promise: Promise.resolve().then(() => mountHost(options, host)),
  };
  registration = host;
  host.promise = host.promise.catch((error: unknown) => {
    if (registration === host) registration = undefined;
    throw error;
  });
  return host.promise;
}
/** Compatibility entry for the live prune-only process fixtures. */
export async function startPruneWorker(options: PruneWorkerOptions) {
  return startHost(options);
}
/** Production collects all four families before registering either workflow or launching the SDK. */
export async function startDurableWorker(options: DurableWorkerOptions): Promise<void> {
  if (
    !options.declarations.reviewOrphans ||
    !options.declarations.conversationOrphans ||
    !options.declarations.placementOrphans
  )
    throw new Error('Production DBOS admission requires all four families');
  await startHost({
    ...options,
    decl: options.declarations.pruneEvents,
    reviewDecl: options.declarations.reviewOrphans,
    conversationDecl: options.declarations.conversationOrphans,
    placementDecl: options.declarations.placementOrphans,
  });
}

async function mountHost(
  {
    boss,
    db,
    decl,
    boundary,
    reviewDecl,
    reviewBoundary,
    conversationDecl,
    placementDecl,
    sessionBoundary,
    reconcileIntervalMs = 15000,
  }: HostOptions,
  host: Host,
) {
  await createOrUpdateQueue(boss, PRUNE_FAMILY, FAST_QUEUE_OPTS);
  await installPruneProducerFence(db);
  if (reviewDecl) {
    await createOrUpdateQueue(boss, REVIEW_ORPHAN_FAMILY, FAST_QUEUE_OPTS);
    await installReviewOrphanProducerFence(db);
  }
  if (conversationDecl && placementDecl) {
    await createOrUpdateQueue(boss, 'prune_orphan_conversation_sessions', FAST_QUEUE_OPTS);
    await createOrUpdateQueue(boss, 'prune_orphan_placement_sessions', FAST_QUEUE_OPTS);
    await installSessionOrphanProducerFence(db);
  }
  const workflow = registerPruneWorkflow(db, boundary);
  const reviewWorkflow = reviewDecl ? registerReviewOrphanWorkflow(db, reviewBoundary) : undefined;
  const reviewBackend =
    reviewDecl && reviewWorkflow
      ? createReviewOrphanBackend({ boss, db, decl: reviewDecl, workflow: reviewWorkflow })
      : undefined;
  const sessionWorkflows =
    conversationDecl && placementDecl
      ? registerSessionOrphanWorkflows(db, sessionBoundary)
      : undefined;
  const sessionBackends =
    conversationDecl && placementDecl && sessionWorkflows
      ? [
          createSessionOrphanBackend({
            boss,
            db,
            binding: {
              family: 'prune_orphan_conversation_sessions',
              decl: conversationDecl,
              workflow: sessionWorkflows.conversationOrphans,
            },
          }),
          createSessionOrphanBackend({
            boss,
            db,
            binding: {
              family: 'prune_orphan_placement_sessions',
              decl: placementDecl,
              workflow: sessionWorkflows.placementOrphans,
            },
          }),
        ]
      : [];
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
  let shutdownPromise: Promise<void> | undefined;
  host.shutdown = () => {
    if (!shutdownPromise)
      shutdownPromise = (async () => {
        stopping = true;
        clearInterval(timer);
        await pending;
        const errors: unknown[] = [];
        for (const backend of [...(reviewBackend ? [reviewBackend] : []), ...sessionBackends]) {
          try {
            await backend.stop();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await DBOS.shutdown({ workflowCompletionTimeoutMS: 3000 });
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'Durable shutdown failed');
      })();
    return shutdownPromise;
  };
  try {
    await DBOS.launch();
    const schedule = decl.schedule;
    if (!schedule) throw new Error('Missing prune schedule');
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
        if (phase === 'pg-boss' && !(await hasRecentDbosPruneReceipt(tx)))
          await boss.schedule(PRUNE_FAMILY, schedule.cron, {}, { tz: schedule.tz });
        else await boss.unschedule(PRUNE_FAMILY);
      });
    };
    const reconcileAll = async () => {
      if (stopping) return;
      const errors: unknown[] = [];
      // One family failing must not starve the other family on this same tick.
      for (const reconcileFamily of [
        reconcile,
        ...(reviewBackend ? [() => reviewBackend.reconcile()] : []),
        ...sessionBackends.map((backend) => () => backend.reconcile()),
      ]) {
        try {
          await reconcileFamily();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Durable backend reconciliation failed');
    };
    await reconcileAll();
    timer = setInterval(() => {
      pending = pending.then(reconcileAll).catch((error: unknown) => {
        console.error('[durable-worker] backend reconciliation failed', error);
      });
    }, reconcileIntervalMs);
    timer.unref();
    return workflow;
  } catch (error) {
    try {
      await host.shutdown();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Durable startup and cleanup failed');
    }
    throw error;
  }
}
