import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';

/** Serialize live-stream append with other intervention delivery writers for one diagnostic. */
export async function lockInterventionDiagnosticDelivery(
  tx: Tx,
  questionId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`intervention:deliver:${questionId}`}))`,
  );
}

/** Serialize with lazy/nightly/recompose writers for one calendar stream date. */
export async function lockPracticeStreamComposeDate(tx: Tx, date: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:compose:${date}`}))`);
}
