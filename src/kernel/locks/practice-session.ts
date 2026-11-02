// Exact transaction lock arguments for the practice session owner's paper and quiz writes.
// Callers keep the transaction scope and their acquisition order.
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';

/** Serializes native capture into one issued paper slot. */
export async function lockPaperNativeSlot(tx: Tx, issuanceId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`paper-native:${issuanceId}`}))`);
}

/** A row lock cannot cover "no active session yet"; this serializes create per paper. */
export async function lockPaperReviewSessionCreate(tx: Tx, paperId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`paper-review-session:${paperId}`}, 0))`,
  );
}

/** Closes the check-then-insert window for one write_quiz task run. */
export async function lockWriteQuizTaskRun(tx: Tx, taskRunId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`write_quiz:${taskRunId}`}, 0))`,
  );
}
