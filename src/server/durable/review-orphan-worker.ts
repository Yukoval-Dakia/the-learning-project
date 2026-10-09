import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import type { JobDecl } from '@/kernel/manifest';
import { buildPruneOrphanReviewSessionsHandler } from '@/server/boss/handlers/prune_orphan_review_sessions';
import { fenceAwareJobHandler } from '@/server/contract-epoch';
import {
  REVIEW_ORPHAN_FAMILY,
  type ReviewOrphanBoundaryHook,
  readReviewOrphanPhase,
  runReviewOrphanTick,
} from './review-orphan-family';

export function registerReviewOrphanWorkflow(
  db: Db,
  boundary: ReviewOrphanBoundaryHook = async () => {},
) {
  return DBOS.registerWorkflow(
    async (scheduledDate: Date, _context: unknown): Promise<void> => {
      const workflowId = DBOS.workflowID;
      if (!workflowId) throw new Error('Review orphan requires a durable workflow identity');
      const result = await DBOS.runStep(
        () =>
          runReviewOrphanTick(
            db,
            { kind: 'dbos', workflowId, scheduledAt: scheduledDate },
            boundary,
          ),
        { name: 'review-orphan-sweep-v1', retriesAllowed: false },
      );
      await boundary({ kind: 'checkpoint-saved', tickId: workflowId });
      console.log('[prune_orphan_review_sessions] durable result', result);
    },
    { name: REVIEW_ORPHAN_FAMILY },
  );
}
export type ReviewOrphanWorkflow = ReturnType<typeof registerReviewOrphanWorkflow>;
export type ReviewOrphanBackendOptions = {
  boss: PgBoss;
  db: Db;
  decl: JobDecl;
  workflow: ReviewOrphanWorkflow;
};

/** The shared host owns launch, timer, pending reconciliation and shutdown. */
export function createReviewOrphanBackend({
  boss,
  db,
  decl,
  workflow,
}: ReviewOrphanBackendOptions) {
  const schedule = decl.schedule;
  if (!schedule || decl.name !== REVIEW_ORPHAN_FAMILY || decl.queue !== 'fast')
    throw new Error('Invalid review orphan declaration');
  let mounted = false;
  return {
    async reconcile(): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select phase from review_orphan_control for share`);
        const phase = await readReviewOrphanPhase(tx);
        if (phase === 'dbos') {
          await boss.unschedule(REVIEW_ORPHAN_FAMILY);
          await DBOS.applySchedules([
            {
              scheduleName: REVIEW_ORPHAN_FAMILY,
              workflowFn: workflow,
              schedule: schedule.cron,
              cronTimezone: schedule.tz,
              automaticBackfill: false,
            },
          ]);
          await DBOS.resumeSchedule(REVIEW_ORPHAN_FAMILY);
        } else if (await DBOS.getSchedule(REVIEW_ORPHAN_FAMILY))
          await DBOS.pauseSchedule(REVIEW_ORPHAN_FAMILY);
        if (phase === 'pg-boss' || phase === 'draining-pg-boss') {
          if (!mounted) {
            await boss.work(
              REVIEW_ORPHAN_FAMILY,
              { pollingIntervalSeconds: 2, batchSize: 1 },
              fenceAwareJobHandler(
                db,
                REVIEW_ORPHAN_FAMILY,
                buildPruneOrphanReviewSessionsHandler(db),
              ),
            );
            mounted = true;
          }
        } else if (mounted) {
          await boss.offWork(REVIEW_ORPHAN_FAMILY, { wait: false });
          mounted = false;
        }
        const [clock] = await tx.execute(
          sql`select coalesce(legacy_not_before <= clock_timestamp(), true) as ready from review_orphan_control`,
        );
        if (phase === 'pg-boss' && clock?.ready === true)
          await boss.schedule(REVIEW_ORPHAN_FAMILY, schedule.cron, {}, { tz: schedule.tz });
        else await boss.unschedule(REVIEW_ORPHAN_FAMILY);
      });
    },
    async stop(): Promise<void> {
      if (mounted) {
        await boss.offWork(REVIEW_ORPHAN_FAMILY, { wait: false });
        mounted = false;
      }
    },
  };
}
