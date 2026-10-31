import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextPrefixedLockKey } from '@/kernel/locks/registry';

/** Serialize live-stream append with other intervention delivery writers for one diagnostic. */
export async function lockInterventionDiagnosticDelivery(
  tx: Tx,
  questionId: string,
): Promise<void> {
  const key = deriveHashtextPrefixedLockKey(advisoryLockRegistry.interventionDeliver, {
    questionId,
  });
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

/** Serialize with lazy/nightly/recompose writers for one calendar stream date. */
export async function lockPracticeStreamComposeDate(tx: Tx, date: string): Promise<void> {
  const key = deriveHashtextPrefixedLockKey(advisoryLockRegistry.streamCompose, { date });
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}
