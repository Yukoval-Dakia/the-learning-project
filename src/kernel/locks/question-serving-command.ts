import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextExtendedLockKey } from '@/kernel/locks/registry';

/** A concurrent same-key serving command waits for the winner's commit, then replays. */
export async function lockQuestionServingCommand(tx: Tx, eventId: string): Promise<void> {
  const key = deriveHashtextExtendedLockKey(advisoryLockRegistry.questionServingCommand, {
    eventId,
  });
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
