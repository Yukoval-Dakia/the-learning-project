import type { Tx } from '@/db/client';
import { sql } from 'drizzle-orm';

const PLACEMENT_SUPPLY_LOCK_NAMESPACE = 'placement-supply:v1:';

/** Serialize pool-visible promotion and paid cold admission for the same KC scope. */
export async function lockPlacementSupplyScopes(
  tx: Tx,
  knowledgeIds: readonly string[],
): Promise<void> {
  for (const knowledgeId of [...new Set(knowledgeIds)].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${PLACEMENT_SUPPLY_LOCK_NAMESPACE + knowledgeId}, 0))`,
    );
  }
}
