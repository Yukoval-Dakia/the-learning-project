import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { drizzle } from 'drizzle-orm/postgres-js';

export const DEFAULT_COMPOSE_LOCK_WAIT_MS = 30_000;

type ReservedConnection = Awaited<ReturnType<Db['$client']['reserve']>>;

function composeBusyError(): ApiError {
  return new ApiError(
    'practice_compose_busy',
    'Practice stream compose is busy; retry the request',
    503,
    { 'Retry-After': '1' },
  );
}

async function reserveBeforeDeadline(db: Db, deadlineAt: Date): Promise<ReservedConnection> {
  const remainingMs = deadlineAt.getTime() - Date.now();
  if (remainingMs <= 0) throw composeBusyError();

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
  if (result === null) throw composeBusyError();
  return result;
}

async function releaseReservedAfterTryLockSettles(
  reserved: ReservedConnection,
  query: Promise<unknown>,
  lockKey: string,
): Promise<void> {
  try {
    await query.catch(() => undefined);
    await reserved
      .unsafe('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
      .catch(() => undefined);
  } finally {
    reserved.release();
  }
}

async function tryComposeSessionLockBeforeDeadline(
  reserved: ReservedConnection,
  lockKey: string,
  deadlineAt: Date,
): Promise<{ status: 'settled'; acquired: boolean } | { status: 'timed_out' }> {
  const remainingMs = deadlineAt.getTime() - Date.now();
  if (remainingMs <= 0) throw composeBusyError();

  const query = reserved<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS acquired
  `;
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
      void releaseReservedAfterTryLockSettles(reserved, query, lockKey);
      return { status: 'timed_out' };
    }
    return { status: 'settled', acquired: result[0]?.acquired === true };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function reserveComposeSessionLock(
  db: Db,
  lockKey: string,
  deadlineAt: Date,
): Promise<ReservedConnection> {
  // A failed try-lock releases its pool slot before backoff so unrelated queries can progress.
  for (;;) {
    if (Date.now() >= deadlineAt.getTime()) throw composeBusyError();
    const reserved = await reserveBeforeDeadline(db, deadlineAt);
    let lockResult: Awaited<ReturnType<typeof tryComposeSessionLockBeforeDeadline>>;
    try {
      lockResult = await tryComposeSessionLockBeforeDeadline(reserved, lockKey, deadlineAt);
    } catch (error) {
      reserved.release();
      throw error;
    }
    if (lockResult.status === 'timed_out') throw composeBusyError();
    try {
      if (lockResult.acquired) {
        if (Date.now() < deadlineAt.getTime()) return reserved;
        await reserved.unsafe('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
        throw composeBusyError();
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

export async function withinComposePaidWorkLock<T>(
  db: Db,
  date: string,
  deadlineAt: Date,
  work: (lockedDb: Db) => Promise<T>,
): Promise<T> {
  const lockKey = `stream:compose-paid:${date}`;
  const reserved = await reserveComposeSessionLock(db, lockKey, deadlineAt);
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
    const savepointName = `compose_paid_${savepointIndex}`;
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
      await reserved.unsafe('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    } finally {
      reserved.release();
    }
  }
}
