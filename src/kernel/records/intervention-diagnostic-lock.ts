// Diagnostic stream placement locks. Key text comes from the lock registry.
// The statements stay hashtext of the full key, and deliver is acquired before compose.
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextTemplateLockKey } from '@/kernel/locks/registry';

export async function lockInterventionDiagnosticStream(
  tx: Tx,
  questionId: string,
  date: string,
): Promise<void> {
  const deliver = deriveHashtextTemplateLockKey(advisoryLockRegistry.interventionDeliver, {
    questionId,
  });
  const compose = deriveHashtextTemplateLockKey(advisoryLockRegistry.streamCompose, { date });
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${deliver}))`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${compose}))`);
}
