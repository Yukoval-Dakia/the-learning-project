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

import type { Tx } from '@/db/client';
import { sql } from 'drizzle-orm';

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
