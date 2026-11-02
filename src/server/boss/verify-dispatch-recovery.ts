import type { Job, PgBoss } from 'pg-boss';
import {
  type EnqueueVerifyFn,
  recoverOrphanVerifyDispatches,
} from '@/capabilities/practice/public';
import type { Db } from '@/db/client';

export const VERIFY_DISPATCH_RECOVERY_QUEUE = 'verify_dispatch_recover';

export function buildVerifyDispatchRecoveryHandler(
  db: Db,
  enqueue: EnqueueVerifyFn,
): (jobs: Job<object>[]) => Promise<void> {
  return async () => {
    await recoverOrphanVerifyDispatches(db, { enqueue });
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
