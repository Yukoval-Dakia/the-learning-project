import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextLockKey } from '@/kernel/locks/registry';

const CONTRACT_EPOCH_TRANSITION_LOCK = deriveHashtextLockKey(
  advisoryLockRegistry.contractEpochTransition,
);

/** Serializes contract-epoch state transitions; held for the caller's transaction. */
export async function lockContractEpochTransition(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${CONTRACT_EPOCH_TRANSITION_LOCK}))`);
}
