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
