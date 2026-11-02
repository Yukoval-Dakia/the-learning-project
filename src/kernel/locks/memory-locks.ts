// Memory pipeline transaction locks. Keys come from the lock registry; the statements are the
// pipeline's original hashtextextended(key, 0) calls.
import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextExtendedLockKey } from '@/kernel/locks/registry';
import { PURPOSE_BRIEF_LOCK } from '@/kernel/read-models/purpose-change';

/** Serializes ingest markers, provider-start reservations and replay grants for one source event. */
export async function lockMemoryIngestSource(tx: Tx, sourceEventId: string): Promise<void> {
  const key = deriveHashtextExtendedLockKey(advisoryLockRegistry.memoryIngestSource, {
    sourceEventId,
  });
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Serializes reconcile dispatch records for one source event. */
export async function lockMemoryDispatchSource(tx: Tx, sourceEventId: string): Promise<void> {
  const key = deriveHashtextExtendedLockKey(advisoryLockRegistry.memoryDispatchSource, {
    sourceEventId,
  });
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Fences reuse of one operator request id across source events. */
export async function lockMemoryOperatorRequest(tx: Tx, requestId: string): Promise<void> {
  const key = deriveHashtextExtendedLockKey(advisoryLockRegistry.memoryOperatorRequest, {
    requestId,
  });
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Serializes purpose-change brief cleanup for one operation and brief scope. */
export async function lockPurposeBriefScope(
  tx: Tx,
  operationId: string,
  scopeKey: string,
): Promise<void> {
  const key = deriveHashtextExtendedLockKey(advisoryLockRegistry.purposeBriefScope, {
    operationId,
    scopeKey,
  });
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** The global brief write lock shared with purpose-change ingestion. */
export async function lockPurposeBrief(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${PURPOSE_BRIEF_LOCK}, 0))`);
}
