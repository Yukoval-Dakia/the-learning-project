import { sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';

export function practiceStreamPartitionKeyParts(date: string, sessionId?: string | null) {
  return sessionId
    ? { namespace: 'stream:session', id: sessionId }
    : { namespace: 'stream:compose', id: date };
}

/**
 * One physical `practice_stream_item` partition: the whole-profile daily stream shares
 * `stream:compose:<date>` with intervention delivery; a scoped review session has its own key.
 */
export async function lockPracticeStreamPartition(
  db: Db | Tx,
  date: string,
  sessionId?: string | null,
): Promise<void> {
  const partition = practiceStreamPartitionKeyParts(date, sessionId);
  const key = `${partition.namespace}:${partition.id}`;
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * Global carry-admission for learning-day carry-forward. Any transaction that
 * will lock more than one `stream:compose:<date>` partition takes this first:
 * canonical order is admission -> target -> sources (ascending), so a holder
 * never waits on another carry tx's target partition and no two-transaction
 * cycle exists. Re-entrant per transaction like every xact advisory lock.
 */
export async function lockPracticeStreamCarryAdmission(db: Db | Tx): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('stream:carry-forward'))`);
}

/** Scope identity for a knowledge-scoped stream, so two first opens create one session. */
export async function lockPracticeStreamScope(
  tx: Tx,
  date: string,
  knowledgeId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:scope:${date}:${knowledgeId}`}))`,
  );
}
