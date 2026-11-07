// Which AI failure notices the learner has closed, kept on the server so another device agrees.
// A key names one episode, so a new failure gets a new key and shows again. Append-only: closing
// never touches the runs or alerts behind the notice.

import { and, desc, eq, gte } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

const DISMISS_ACTION = 'experimental:ai_notice_dismissed';
/** Episodes are days old at most; an older key can't match a notice that is still showing. */
const LOOKBACK_MS = 60 * 86_400_000;
const MAX_ROWS = 500;

export async function listDismissedAiNotices(db: Db, now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, DISMISS_ACTION),
        gte(event.created_at, new Date(now.getTime() - LOOKBACK_MS)),
      ),
    )
    .orderBy(desc(event.created_at))
    .limit(MAX_ROWS);
  const keys = new Set<string>();
  for (const { payload } of rows) {
    const recorded = (payload as { keys?: unknown }).keys;
    if (!Array.isArray(recorded)) continue;
    for (const key of recorded) if (typeof key === 'string') keys.add(key);
  }
  return [...keys];
}

export async function dismissAiNotices(
  db: Db,
  keys: readonly string[],
  now: Date = new Date(),
): Promise<{ keys: string[] }> {
  const id = newId();
  await writeEvent(db, {
    id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: DISMISS_ACTION,
    subject_kind: 'event',
    subject_id: id,
    payload: { keys: [...keys], dismissed_at: now.toISOString() },
    // A UI ledger row, not learner evidence: opt out of memory ingestion.
    ingest_at: now,
    created_at: now,
  });
  return { keys: await listDismissedAiNotices(db, now) };
}
