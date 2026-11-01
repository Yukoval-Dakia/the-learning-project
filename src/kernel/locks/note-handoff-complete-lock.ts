import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextExtendedLockKey } from '@/kernel/locks/registry';

/** Serializes completion-event writes for one handoff completion id. */
export async function lockNoteHandoffComplete(tx: Tx, completionId: string): Promise<void> {
  const key = deriveHashtextExtendedLockKey(advisoryLockRegistry.noteHandoffComplete, {
    completionId,
  });
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
