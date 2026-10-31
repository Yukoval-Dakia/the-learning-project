// Correction lock keys. The source lock key comes from the registry; its statement
// stays hashtextextended(text, 0). Kernel events must not import the agency helper.
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextExtendedLockKey } from '@/kernel/locks/registry';

export function eventCorrectionLockKey(eventId: string): string {
  return deriveHashtextExtendedLockKey(advisoryLockRegistry.interventionSource, { eventId });
}

/** Serializes correction inserts with activation's complete direct-chain read. */
export function eventCorrectionsGlobalLockKey(): string {
  return 'intervention:corrections:all';
}

export async function lockEventCorrectionSource(tx: Tx, eventId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventCorrectionLockKey(eventId)}, 0))`,
  );
}
