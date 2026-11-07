import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextLockKey } from '@/kernel/locks/registry';

export const AGENT_WORKSPACE_POOL_LOCK = deriveHashtextLockKey(
  advisoryLockRegistry.agentWorkspacePool,
);

/**
 * Serializes every workspace claim/delete decision so pool-quota and owner-slot
 * checks cannot interleave. Always taken before learning_session row locks;
 * copilot lifecycle locks never acquire it.
 */
export async function lockAgentWorkspacePool(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${AGENT_WORKSPACE_POOL_LOCK}))`);
}
