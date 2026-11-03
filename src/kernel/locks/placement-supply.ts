import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextExtendedLockKey } from '@/kernel/locks/registry';

/** Serialize pool-visible promotion and paid cold admission for the same KC scope. */
export async function lockPlacementSupplyScopes(
  tx: Tx,
  knowledgeIds: readonly string[],
): Promise<void> {
  for (const knowledgeId of [...new Set(knowledgeIds)].sort()) {
    const key = deriveHashtextExtendedLockKey(advisoryLockRegistry.placementSupplyScope, {
      knowledgeId,
    });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}
