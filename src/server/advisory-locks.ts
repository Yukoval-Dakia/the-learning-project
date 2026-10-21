// Shared sorted advisory-lock acquisition. Sorting ids preserves the deadlock-avoidance
// order used by the other root→child writers; locks release at transaction end. This util
// is table-free by design, so sharing it cannot weaken the per-table single-writer guards.

import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';

export {
  LEARNING_STATE_WRITE_LOCK,
  acquireLearningStateWriteLock,
  withLearningStateLock,
} from '@/db/learning-state-lock';

/** Acquire `pg_advisory_xact_lock(hashtext('<namespace>:<id>'))` for every id in sorted order. */
export async function acquireSortedAdvisoryLocks(
  tx: Tx,
  namespace: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of [...ids].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${namespace}:${id}`}))`);
  }
}
