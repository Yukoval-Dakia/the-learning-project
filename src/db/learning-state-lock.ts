// Shared PostgreSQL transaction lock for assessment and intervention learning writes.
// This module owns the lock; it has no server or capability runtime dependency.
// The key literal is owned by the advisory-lock registry (YUK-1577); it is re-exported
// here unchanged so every existing `learning-state-lock` / `advisory-locks` import site
// keeps working — the SQL statement, key, and acquisition semantics are identical.
import { sql } from 'drizzle-orm';
import { LEARNING_STATE_WRITE_LOCK } from './advisory-lock-registry';
import type { Db, Tx } from './client';

export { LEARNING_STATE_WRITE_LOCK };

/** Serialize every material_fsrs_state / mastery_state mutation before any row access. */
export async function acquireLearningStateWriteLock(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LEARNING_STATE_WRITE_LOCK}))`);
}

/**
 * Run `fn` under the global learning-state write lock G, inside a transaction. Standardizes the
 * Db-vs-Tx dispatch on the DOCUMENTED `'$client' in db` polarity (src/db/client.ts: a `Tx` does not
 * carry `$client`) instead of the undocumented `'rollback' in db` duck-type — if a future drizzle
 * added `rollback` to the base `Db`, that heuristic would silently run the mutation OUTSIDE a
 * transaction and release the xact-scoped advisory lock immediately (session-level per statement).
 * A top-level `Db` opens a real tx so G is HELD across `fn`; an already-open `Tx` runs inline (the
 * caller owns the tx and its G ordering). Extracted from the duplicated apply-closure in
 * fsrs/state.ts + mastery/state.ts (YUK-497 wave-4).
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
