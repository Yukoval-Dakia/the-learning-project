import { sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';

function partitionKey(date: string, sessionId?: string | null): string {
  return sessionId ? `stream:session:${sessionId}` : `stream:compose:${date}`;
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
  const key = partitionKey(date, sessionId);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

/** Callers holding other business locks must roll back rather than wait for a partition. */
export async function tryLockPracticeStreamPartition(
  tx: Tx,
  date: string,
  sessionId?: string | null,
): Promise<boolean> {
  const key = partitionKey(date, sessionId);
  const [result] = await tx.execute<{ acquired: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`,
  );
  return result?.acquired === true;
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
