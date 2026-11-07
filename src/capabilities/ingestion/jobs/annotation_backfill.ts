// Background annotation backfill consumer (YUK-1994 slice 3).
//
// Repairs the two labels a question may have missed at enrollment: the knowledge
// point and the solution-method annotation. The auto_enroll job sends the just
// enrolled question ids; a cron delivery with no payload is the durable sweep that
// catches anything the immediate send lost. Per-row paid failures are counted on the
// row (bounded attempts) inside runAnnotationBackfill, so only an infrastructure
// fault escapes and gets a pg-boss retry.

import type { Job } from 'pg-boss';

import { runAnnotationBackfill } from '@/capabilities/ingestion/server/annotation-backfill';
import type { Db } from '@/db/client';

export interface AnnotationBackfillJobData {
  /** Optional immediate batch from auto_enroll; absent for the sweep delivery. */
  questionIds?: string[];
}

export function buildAnnotationBackfillHandler(db: Db) {
  return async (jobs: Job<AnnotationBackfillJobData>[]): Promise<void> => {
    for (const job of jobs) {
      const questionIds = job.data?.questionIds;
      try {
        const result = await runAnnotationBackfill({
          db,
          ...(Array.isArray(questionIds) && questionIds.length > 0 ? { questionIds } : {}),
          providerAttempt: {
            db,
            caller: 'worker',
            deadlineAt: new Date(Date.now() + 20_000),
            operationAnchor: job.id,
          },
        });
        console.log(
          `[annotation_backfill] ${questionIds?.length ?? 'sweep'} → scanned=${result.scanned} knowledge=${result.knowledge_filled}/${result.knowledge_failed} solution=${result.solution_filled}/${result.solution_failed} skipped=${result.solution_skipped} infra=${result.infra_failures} policy_blocked=${result.policy_blocked} exhausted=${result.exhausted}`,
        );
      } catch (err) {
        // Per-row faults are absorbed inside the runner; an escape is infrastructure.
        console.error('[annotation_backfill] delivery failed', err);
        throw err;
      }
    }
  };
}
