// Correction advisory locks. Key text comes from the lock registry; the statement
// stays hashtextextended(text, 0). writeEvents takes corrections:all, then each source.
// Kernel events must not import the agency intervention helper.
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import {
  advisoryLockRegistry,
  deriveHashtextExtendedExactLockKey,
  deriveHashtextExtendedLockKey,
} from '@/kernel/locks/registry';

export function eventCorrectionLockKey(eventId: string): string {
  return deriveHashtextExtendedLockKey(advisoryLockRegistry.interventionSource, { eventId });
}

/** Serializes correction inserts with activation's complete direct-chain read. */
export function eventCorrectionsGlobalLockKey(): string {
  return deriveHashtextExtendedExactLockKey(advisoryLockRegistry.interventionCorrectionsAll);
}

async function lockHashtextExtended(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function lockEventCorrectionsAll(tx: Tx): Promise<void> {
  await lockHashtextExtended(tx, eventCorrectionsGlobalLockKey());
}

export async function lockEventCorrectionSource(tx: Tx, eventId: string): Promise<void> {
  await lockHashtextExtended(tx, eventCorrectionLockKey(eventId));
}
