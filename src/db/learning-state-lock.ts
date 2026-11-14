// Shared PostgreSQL transaction locks for learning writes: global G and sorted caller keys.
// G's hashtext argument comes from the lock registry; this module still issues the same SQL.
// No server or capability runtime dependency.
import { sql } from 'drizzle-orm';
import { advisoryLockRegistry, deriveHashtextLockKey } from '@/kernel/locks/registry';
import type { Db, Tx } from './client';

export const LEARNING_STATE_WRITE_LOCK = deriveHashtextLockKey(
  advisoryLockRegistry.learningStateWrite,
);

/** Serialize every material_fsrs_state / mastery_state mutation before any row access. */
export async function acquireLearningStateWriteLock(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LEARNING_STATE_WRITE_LOCK}))`);
}

/** Completion already holds relation fences and must never wait behind a G-first writer. */
export async function tryLearningStateWriteLock(tx: Tx): Promise<boolean> {
  const [row] = await tx.execute<{ acquired: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${LEARNING_STATE_WRITE_LOCK})) AS acquired`,
  );
  return row?.acquired === true;
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

/** Failed nonblocking attempts retain earlier locks until the owner rolls back. */
export function acquireSortedAdvisoryLocks(
  tx: Tx,
  namespace: string,
  ids: readonly string[],
): Promise<undefined>;
export function acquireSortedAdvisoryLocks(
  tx: Tx,
  namespace: string,
  ids: readonly string[],
  options: { noWait: true },
): Promise<boolean>;
export async function acquireSortedAdvisoryLocks(
  tx: Tx,
  namespace: string,
  ids: readonly string[],
  options?: { noWait: true },
): Promise<boolean | undefined> {
  for (const id of [...ids].sort()) {
    const key = `${namespace}:${id}`;
    if (options?.noWait) {
      const [result] = await tx.execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`,
      );
      if (result?.acquired !== true) return false;
    } else {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    }
  }
  return options?.noWait ? true : undefined;
}
