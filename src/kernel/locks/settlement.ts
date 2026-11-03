// Exact advisory-lock arguments for the settlement owner (native appeal,
// correction, resolution, historical rejudge). Keys are the content-derived
// event identities themselves; callers keep the transaction scope and their
// acquisition order.
import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';

/** One native appeal identity: concurrent requests read or write the same row. */
export async function lockNativeAppeal(tx: Tx, appealId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${appealId}))`);
}

/** One correction request identity per (evaluation, proposal). */
export async function lockEvaluationCorrection(tx: Tx, correctionId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${correctionId}))`);
}

/** One native resolution identity; write is first-wins under the lock. */
export async function lockNativeResolution(tx: Db | Tx, resolutionId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${resolutionId}))`);
}

/** Serializes a historical appeal's rejudge against concurrent deliveries. */
export async function lockRejudgeAppeal(tx: Tx, appealId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${appealId}, 0))`);
}
