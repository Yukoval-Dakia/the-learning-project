// Probe lifecycle transaction locks. Arguments come from the lock registry.
// The statements stay a single int key and hashtextextended(id, salt), salt literal.
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import {
  advisoryLockRegistry,
  deriveHashtextExtendedIdentityLock,
  deriveIntLiteralLockKey,
} from '@/kernel/locks/registry';

const PROBE_SERVE_LOCK_KEY = deriveIntLiteralLockKey(advisoryLockRegistry.probeServeCap);

const lockHashtextExtendedIdentity: {
  readonly [Salt in 0 | 1]: (tx: Tx, key: string) => Promise<unknown>;
} = {
  0: (tx, key) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`),
  1: (tx, key) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 1))`),
};

/** One key for every serve, so the cap count and insert cannot interleave. */
export async function lockProbeServe(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROBE_SERVE_LOCK_KEY})`);
}

export async function lockProbeQuestion(tx: Tx, probeQuestionId: string): Promise<void> {
  const lock = deriveHashtextExtendedIdentityLock(
    advisoryLockRegistry.probeQuestion,
    probeQuestionId,
  );
  await lockHashtextExtendedIdentity[lock.salt](tx, lock.key);
}

export async function lockConjectureFold(tx: Tx, conjectureEventId: string): Promise<void> {
  const lock = deriveHashtextExtendedIdentityLock(
    advisoryLockRegistry.conjectureFold,
    conjectureEventId,
  );
  await lockHashtextExtendedIdentity[lock.salt](tx, lock.key);
}
