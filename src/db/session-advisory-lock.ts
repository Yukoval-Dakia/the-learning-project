import { drizzle } from 'drizzle-orm/postgres-js';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';

type ReservedConnection = Awaited<ReturnType<Db['$client']['reserve']>>;

type Lock = { key: string; namespace?: string; busy: () => Error };

async function unlock(reserved: ReservedConnection, lock: Lock) {
  if (lock.namespace === undefined) {
    await reserved.unsafe('SELECT pg_advisory_unlock(hashtext($1))', [lock.key]);
  } else {
    await reserved.unsafe('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [
      lock.namespace,
      lock.key,
    ]);
  }
}

async function reserveBeforeDeadline(
  db: Db,
  deadlineAt: Date,
  lock: Lock,
): Promise<ReservedConnection> {
  const remainingMs = deadlineAt.getTime() - Date.now();
  if (remainingMs <= 0) throw lock.busy();

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const pendingReservation = db.$client.reserve().then((reserved) => {
    if (timedOut) {
      reserved.release();
      return null;
    }
    return reserved;
  });
  let result: ReservedConnection | null;
  try {
    result = await Promise.race([
      pendingReservation,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (result === null) throw lock.busy();
  return result;
}

async function releaseReservedAfterTryLockSettles(
  reserved: ReservedConnection,
  query: Promise<unknown>,
  lock: Lock,
): Promise<void> {
  try {
    await query.catch(() => undefined);
    await unlock(reserved, lock).catch((err) => {
      console.error('[session_lock] advisory unlock failed after timeout', lock.key, err);
    });
  } finally {
    reserved.release();
  }
}

async function trySessionLockBeforeDeadline(
  reserved: ReservedConnection,
  lock: Lock,
  deadlineAt: Date,
): Promise<{ status: 'settled'; acquired: boolean } | { status: 'timed_out' }> {
  const remainingMs = deadlineAt.getTime() - Date.now();
  if (remainingMs <= 0) throw lock.busy();

  const query =
    lock.namespace === undefined
      ? reserved<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_lock(hashtext(${lock.key})) AS acquired`
      : reserved<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_lock(hashtext(${lock.namespace}), hashtext(${lock.key})) AS acquired`;
  const timedOut = Symbol('timed_out');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      query,
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => {
          resolve(timedOut);
        }, remainingMs);
      }),
    ]);
    if (result === timedOut) {
      void releaseReservedAfterTryLockSettles(reserved, query, lock);
      return { status: 'timed_out' };
    }
    return { status: 'settled', acquired: result[0]?.acquired === true };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function reserveSessionLock(
  db: Db,
  lock: Lock,
  deadlineAt: Date,
): Promise<ReservedConnection> {
  // A failed try-lock releases its pool slot before backoff so unrelated queries can progress.
  for (;;) {
    if (Date.now() >= deadlineAt.getTime()) throw lock.busy();
    const reserved = await reserveBeforeDeadline(db, deadlineAt, lock);
    let lockResult: Awaited<ReturnType<typeof trySessionLockBeforeDeadline>>;
    try {
      lockResult = await trySessionLockBeforeDeadline(reserved, lock, deadlineAt);
    } catch (error) {
      reserved.release();
      throw error;
    }
    if (lockResult.status === 'timed_out') throw lock.busy();
    try {
      if (lockResult.acquired) {
        if (Date.now() < deadlineAt.getTime()) return reserved;
        await unlock(reserved, lock);
        throw lock.busy();
      }
    } catch (error) {
      reserved.release();
      throw error;
    }
    reserved.release();
    const remainingMs = deadlineAt.getTime() - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
    }
  }
}

export async function withinSessionAdvisoryLock<T>(
  db: Db,
  lock: Lock,
  deadlineAt: Date,
  work: (lockedDb: Db) => Promise<T>,
): Promise<T> {
  const reserved = await reserveSessionLock(db, lock, deadlineAt);
  // ReservedSql omits options/begin at runtime despite its Sql type; Drizzle requires both.
  reserved.options = db.$client.options;
  const beginOnReserved = async <T>(
    workInTransaction: (transactionClient: ReservedConnection) => T | Promise<T>,
  ): Promise<T> => {
    await reserved.unsafe('BEGIN');
    try {
      const result = await workInTransaction(reserved);
      await reserved.unsafe('COMMIT');
      return result;
    } catch (error) {
      await reserved.unsafe('ROLLBACK');
      throw error;
    }
  };
  let savepointIndex = 0;
  const savepointOnReserved = async <T>(
    workInSavepoint: (transactionClient: ReservedConnection) => T | Promise<T>,
  ): Promise<T> => {
    const savepointName = `session_lock_${savepointIndex}`;
    savepointIndex += 1;
    await reserved.unsafe(`SAVEPOINT ${savepointName}`);
    try {
      const result = await workInSavepoint(reserved);
      await reserved.unsafe(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      try {
        await reserved.unsafe(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await reserved.unsafe(`RELEASE SAVEPOINT ${savepointName}`);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Failed to roll back nested transaction');
      }
      throw error;
    }
  };
  Object.defineProperties(reserved, {
    begin: { value: beginOnReserved },
    savepoint: { value: savepointOnReserved },
  });
  const lockedDb: Db = drizzle(reserved, { schema });
  try {
    return await work(lockedDb);
  } finally {
    try {
      await unlock(reserved, lock);
    } finally {
      reserved.release();
    }
  }
}
