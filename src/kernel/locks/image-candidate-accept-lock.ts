// Lock key for the retired image_candidate accept path. The accept applier is
// gone, but a rolling deploy can still run the old claim/finalize transactions
// that took this lock; the handover driver takes the same key so a terminal
// decision written during the window serializes against an in-flight accept.
import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextExtendedLockKey } from '@/kernel/locks/registry';

/** Serializes one image_candidate proposal's accept claim/finalize path. */
export async function lockImageCandidateAccept(tx: Tx, proposalId: string): Promise<void> {
  const key = deriveHashtextExtendedLockKey(advisoryLockRegistry.imageCandidateAccept, {
    proposalId,
  });
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
