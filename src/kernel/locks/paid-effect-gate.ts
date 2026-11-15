import { sql } from 'drizzle-orm';
import {
  type PaidEffectIdentity,
  paidEffectGateLockKey,
} from '@/core/paid-work/protocol/paid-effect-protocol';
import type { Tx } from '@/db/client';

/** Cross-revision entity gate; the paid owner takes family and identity locks first. */
export async function lockPaidEffectEntityGate(
  tx: Tx,
  identity: PaidEffectIdentity,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${paidEffectGateLockKey(identity)}, 0))`,
  );
}
