// Transaction locks for intervention store writes, recovery, and probe-result delivery.
// Key text comes from the lock registry; the statement stays hashtextextended(text, 0), the registered salt.
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import {
  advisoryLockRegistry,
  deriveHashtextExtendedExactLockKey,
  deriveHashtextExtendedLockKey,
} from '@/kernel/locks/registry';

async function lockHashtextExtended(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function lockInterventionInstance(
  tx: Tx,
  interventionId: string,
  version: number,
): Promise<void> {
  await lockHashtextExtended(
    tx,
    deriveHashtextExtendedLockKey(advisoryLockRegistry.interventionInstance, {
      interventionId,
      version: String(version),
    }),
  );
}

export async function lockInterventionCorrectionsAll(tx: Tx): Promise<void> {
  await lockHashtextExtended(
    tx,
    deriveHashtextExtendedExactLockKey(advisoryLockRegistry.interventionCorrectionsAll),
  );
}

export async function lockInterventionSource(tx: Tx, eventId: string): Promise<void> {
  await lockHashtextExtended(
    tx,
    deriveHashtextExtendedLockKey(advisoryLockRegistry.interventionSource, { eventId }),
  );
}
