// Exact advisory-lock arguments for the grading owner (attempt capture, judge delivery,
// recorded model claims, slice admission). Callers keep the transaction scope and their
// acquisition order.
import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';

/** One judge_run identity: delivery, receipts and notifications serialize on the run id. */
export async function lockJudgeRun(tx: Tx, runId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
}

/** Serializes the judge_pending_reconcile sweep receipt across overlapping ticks. */
export async function lockJudgePendingSweep(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(1356,2)`);
}

/** Pending receipts and retries share one occurrence anchor; capture is first-write-wins. */
export async function lockAssessmentAttemptCapture(tx: Tx, attemptId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${attemptId}))`);
}

/** One recorded model-unit claim event. */
export async function lockRecordedModelClaim(tx: Tx, claimId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${claimId}))`);
}

/** The same assessment retry identity cannot acquire a second chat/session authority. */
export async function lockReviewAnswerRetry(
  tx: Tx,
  evaluationGroupId: string,
  idempotencyKey: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`review-answer:${evaluationGroupId}:${idempotencyKey}`}, 0))`,
  );
}

/**
 * Session lock held on a reserved connection for one slice's admission run; a concurrent
 * run for the same slice returns `lock_busy` instead of waiting.
 */
export async function withModelSliceAdmissionLock<T>(
  db: Db,
  sliceId: string,
  work: () => Promise<T>,
): Promise<T | { outcome: 'lock_busy' }> {
  const key = `model-slice-admission:${sliceId}`;
  const reserved = await db.$client.reserve();
  let acquired = false;
  try {
    const rows = await reserved<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext(${key})) AS acquired
    `;
    acquired = rows[0]?.acquired === true;
    if (!acquired) return { outcome: 'lock_busy' };
    return await work();
  } finally {
    if (acquired) {
      await reserved.unsafe('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch((error) => {
        console.error('[model-slice-admission] advisory unlock failed', sliceId, error);
      });
    }
    reserved.release();
  }
}
