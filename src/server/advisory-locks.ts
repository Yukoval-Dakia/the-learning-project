// YUK-543 — shared sorted advisory-lock acquisition (PostgreSQL consistent-lock-ordering doctrine).
//
// TABLE-FREE by design: this util only issues `pg_advisory_xact_lock(hashtext('<ns>:<id>'))`
// statements — it never references a table, so sharing it does NOT weaken the step9 fs-walk
// single-writer guards (those regex on db.insert/update(<table>); verified in the YUK-543 review
// round). The per-table retire functions deliberately KEEP their table operations as four explicit
// copies (a dynamic-table shared helper would blind the guard) — only this lock loop is shared.
//
// Sorted acquisition order (string sort over ids) is the deadlock-avoidance pattern established by
// updateThetaForAttempt (src/server/mastery/state.ts) and mirrored by every YUK-543 retire fn.
// Locks are transaction-scoped: released automatically at tx commit/rollback.

import type { Db, Tx } from '@/db/client';
import { sql } from 'drizzle-orm';

export const LEARNING_STATE_WRITE_LOCK = 'learning-state:write';

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

/**
 * Acquire `pg_advisory_xact_lock(hashtext('<namespace>:<id>'))` for every id, in sorted string
 * order. Namespaces in use: `fsrs:knowledge` (mastery+fsrs, shared with the grading path),
 * `axis_state:<kind>` / `kc_typed:<kind>` (their own modules), `knowledge_edge` (merge edge rewire).
 */
export async function acquireSortedAdvisoryLocks(
  tx: Tx,
  namespace: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of [...ids].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${namespace}:${id}`}))`);
  }
}
