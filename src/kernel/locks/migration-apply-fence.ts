import type postgres from 'postgres';

import { advisoryLockRegistry, deriveHashtextLockKey } from '@/kernel/locks/registry';

const MIGRATION_APPLY_FENCE = deriveHashtextLockKey(advisoryLockRegistry.migrationApplyFence);

/**
 * Takes the migration-apply session fence on `client` without waiting. Rehearsal uses
 * it to stand in for a competing writer; the lock lives until the client closes.
 */
export async function tryHoldMigrationApplyFence(client: postgres.Sql): Promise<boolean> {
  const rows = await client`select pg_try_advisory_lock(hashtext(${MIGRATION_APPLY_FENCE})) as ok`;
  return rows[0]?.ok === true;
}
