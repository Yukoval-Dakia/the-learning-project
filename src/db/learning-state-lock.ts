// Shared PostgreSQL transaction locks for learning writes: global G and sorted caller keys.
// This module owns the lock; it has no server or capability runtime dependency.
import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client';

export const LEARNING_STATE_WRITE_LOCK = 'learning-state:write';

/** Serialize every material_fsrs_state / mastery_state mutation before any row access. */
export async function acquireLearningStateWriteLock(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LEARNING_STATE_WRITE_LOCK}))`);
}

/**
 * Run `fn` under the global learning-state write lock G, inside a transaction. Dispatch uses the
 * DOCUMENTED `'$client' in db` polarity (src/db/client.ts: a `Tx` does not carry `$client`) rather
 * than the undocumented `'rollback' in db` duck-type — if a future drizzle added `rollback` to the
 * base `Db`, that heuristic would run the mutation OUTSIDE a transaction and release the
 * xact-scoped advisory lock immediately (session-level per statement). A top-level `Db` opens a
 * real tx so G is HELD across `fn`; an already-open `Tx` runs inline (the caller owns the tx and
 * its G ordering).
 */
export async function withLearningStateLock<T>(
  db: Db | Tx,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const apply = async (tx: Tx): Promise<T> => {
    await acquireLearningStateWriteLock(tx);
    return fn(tx);
  };
  if ('$client' in db) return db.transaction(apply);
  return apply(db);
}

/** 按 id 排序逐个取 `pg_advisory_xact_lock(hashtext('<namespace>:<id>'))`，避免重叠 id 集死锁。 */
export async function acquireSortedAdvisoryLocks(
  tx: Tx,
  namespace: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of [...ids].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${namespace}:${id}`}))`);
  }
}
