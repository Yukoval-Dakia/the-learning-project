// YUK-252 — single source of truth for db-test fork partitioning.
//
// Keep this file dependency-free: tests/setup.db-fork.ts imports it before any
// application/db module is allowed to load.
export const DB_FORK_COUNT = 4;
export const DB_FORK_DATABASE_PREFIX = 'test_fork';

export function dbForkDatabaseName(poolId: number | string) {
  return `${DB_FORK_DATABASE_PREFIX}_${poolId}`;
}
