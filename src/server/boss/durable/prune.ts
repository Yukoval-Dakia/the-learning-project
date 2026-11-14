import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import type { DurableFamilyAdapter, MountedDurableFamily } from '@/kernel/manifest';
import { FAST_QUEUE_OPTS, createOrUpdateQueue } from '@/server/boss/queue-config';
import {
  PRUNE_FAMILY,
  commitPrune,
  drainLegacyPrune,
  hasRecentDbosPruneReceipt,
  installPruneProducerFence,
  readPrunePhase,
} from '@/server/durable/prune-family';
import { waitForRunnableEpoch } from '@/server/migration/contract-epoch/epoch';

export type PruneBoundary = 'business-committed' | 'checkpoint-saved';
export type PruneWorkflow = ReturnType<typeof registerPruneWorkflow>;

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

/** The prune family's mount adapter; owned here so the manifest stays a pure
 *  job contribution and the host never enumerates member names. */
export const pruneFamily: DurableFamilyAdapter = {
  label: 'prune',
  required: true,
  requiredPeers: ['review-orphan', 'session-orphan'],
  members: [
    { name: PRUNE_FAMILY, queue: 'fast', scheduled: true, singleton: 'forbidden', required: true },
  ],
  async mount(context): Promise<MountedDurableFamily | undefined> {
    const boss = context.boss as PgBoss;
    const db = context.db as Db;
    const decls = context.decls;
    const boundaries = context.boundaries;
    const decl = decls[PRUNE_FAMILY];
    if (!decl) return undefined;
    const boundary = boundaries.prune as ((name: PruneBoundary) => Promise<void>) | undefined;
    await createOrUpdateQueue(boss, PRUNE_FAMILY, FAST_QUEUE_OPTS);
    await installPruneProducerFence(db);
    const workflow = registerPruneWorkflow(db, boundary);
    const schedule = decl.schedule;
    if (!schedule) throw new Error('Missing prune schedule');
    let mounted = false;
    return {
      workflow,
      async reconcile() {
        await db.transaction(async (tx) => {
          // SHARE lets pg-boss's producer trigger read the row; transitions take
          // UPDATE and cannot race a stale cron registration.
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
              await boss.work(
                PRUNE_FAMILY,
                { pollingIntervalSeconds: 2, batchSize: 1 },
                async () => {
                  await waitForRunnableEpoch(db);
                  await drainLegacyPrune(db);
                },
              );
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
      },
      async stop() {
        if (mounted) {
          await boss.offWork(PRUNE_FAMILY, { wait: false });
          mounted = false;
        }
      },
    };
  },
};
