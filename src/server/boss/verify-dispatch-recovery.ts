import type { Job, PgBoss } from 'pg-boss';
import {
  type EnqueueVerifyFn,
  assertSourceGroundingLaneConfigured,
  recoverHeldServingRechecks,
  recoverOrphanVerifyDispatches,
  recoverWebSupplies,
} from '@/capabilities/practice/public';
import type { Db } from '@/db/client';
import { preflightTaskExecution } from '@/server/ai/runner-preflight';
import { resolveSubjectProfile } from '@/subjects/profile';
import { VERIFY_DISPATCH_RECOVERY_QUEUE } from './queue-names';

export function buildVerifyDispatchRecoveryHandler(
  db: Db,
  enqueue: EnqueueVerifyFn,
): (jobs: Job<object>[]) => Promise<void> {
  // Zero-send lane probe for the sweep's recovery re-drives: adapter startup for
  // the solve + grounding lanes only — no session, no prompt. A broken lane
  // must not mint paid attempts; the holds re-arm next sweep once it is fixed.
  const sourceVerifyRecoveryPreflight = async () => {
    const subjectProfile = resolveSubjectProfile(null);
    await preflightTaskExecution(
      'SolutionGenerateTask',
      { text: '{}', images: [] },
      { db, subjectProfile },
    );
    await assertSourceGroundingLaneConfigured({ db, subjectProfile });
  };
  return async () => {
    await recoverOrphanVerifyDispatches(db, { enqueue, sourceVerifyRecoveryPreflight });
    // Lost-delivery fallback only: web demands normally advance on their question's publication
    // (practice.web-supply-observe). This sweep also drains orphan verify intents.
    await recoverWebSupplies(db, { enqueue });
    // YUK-1664 — recovery pass for the system's serving recheck: bounded to 50
    // held groups, it picks up holds that predate the result-event
    // subscription and any delivery the bus lost.
    await recoverHeldServingRechecks(db);
  };
}

/**
 * start-worker calls this after the verifier queues exist. The consumer is mounted earlier.
 * A send before those queues exist throws, and the drain waits for the nightly cron.
 * No send dedupe. Completion makes a repeat pass a no-op, and skipping a later boot would wait for that cron.
 */
export async function sendVerifyDispatchStartupRecovery(boss: PgBoss): Promise<void> {
  await boss.send(VERIFY_DISPATCH_RECOVERY_QUEUE, { trigger: 'startup' });
}
