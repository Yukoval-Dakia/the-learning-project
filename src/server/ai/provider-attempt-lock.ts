// Transaction locks for one provider-attempt lifecycle. Key text comes from the
// lock registry; the statement stays hashtextextended(text, 0), the registered salt.
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextExtendedLockKey } from '@/kernel/locks/registry';

type SuffixParts<Namespace extends { readonly suffixFields: readonly string[] }> = {
  readonly [K in Namespace['suffixFields'][number]]: string;
};

async function lockHashtextExtended(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function lockProviderAttempt(tx: Tx, attemptId: string): Promise<void> {
  await lockHashtextExtended(
    tx,
    deriveHashtextExtendedLockKey(advisoryLockRegistry.providerAttempt, { attemptId }),
  );
}

export async function lockProviderAttemptLane(tx: Tx, lane: string): Promise<void> {
  await lockHashtextExtended(
    tx,
    deriveHashtextExtendedLockKey(advisoryLockRegistry.providerAttemptLane, { lane }),
  );
}

export async function lockProviderAttemptOperationKind(
  tx: Tx,
  parts: SuffixParts<typeof advisoryLockRegistry.providerAttemptOperationKind>,
): Promise<void> {
  await lockHashtextExtended(
    tx,
    deriveHashtextExtendedLockKey(advisoryLockRegistry.providerAttemptOperationKind, parts),
  );
}
