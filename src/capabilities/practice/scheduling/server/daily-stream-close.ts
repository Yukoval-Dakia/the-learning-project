// Whole-profile daily close. The practice list decides when the day is done;
// the review session and summary job already exist.

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { learning_session, practice_stream_item } from '@/db/schema';
import { lockPracticeStreamPartition } from '@/kernel/locks/practice-stream';
import {
  dailyStreamEntrypoint,
  earliestDailyStreamAnswerAt,
  enqueueReviewSessionSummary,
  startReviewSession,
  transitionReviewSessionState,
} from '../../session/public';
import { filterProspectiveStreamQuestions } from './stream-view';

type DbLike = Db | Tx;
type StreamItemRow = typeof practice_stream_item.$inferSelect;

const OPEN_STREAM_STATUSES = ['pending', 'in_progress', 'skipped'] as const;

type DailyStreamClose = { kind: 'summarize'; sessionId: string } | { kind: 'skip' };

function dailyPartition(date: string) {
  return and(eq(practice_stream_item.date, date), isNull(practice_stream_item.session_id));
}

/**
 * A stored question the practice list no longer serves, and that has no
 * accepted answer to recover, stays in the table. It is not an open slot:
 * the day finishes when every slot still on that list is done.
 */
async function openDailyItemCount(db: DbLike, date: string): Promise<number> {
  const rows = await db.select().from(practice_stream_item).where(dailyPartition(date));
  const visible = await filterProspectiveStreamQuestions(db, rows);
  return visible.rows.filter((row) =>
    (OPEN_STREAM_STATUSES as readonly string[]).includes(row.status),
  ).length;
}

/**
 * The whole-profile partition cannot store a session id. When the last slot
 * still on the practice list closes, one review session for that calendar day
 * is completed and the existing summary job is enqueued. A second close of the
 * same day finds the session already completed and does not enqueue again.
 */
async function closeDailyStream(db: Db, date: string): Promise<DailyStreamClose> {
  return db.transaction(async (tx) => {
    await lockPracticeStreamPartition(tx, date);
    if ((await openDailyItemCount(tx, date)) !== 0) return { kind: 'skip' };
    const entrypoint = dailyStreamEntrypoint(date);
    const existing = await tx
      .select({ id: learning_session.id, status: learning_session.status })
      .from(learning_session)
      .where(and(eq(learning_session.type, 'review'), eq(learning_session.entrypoint, entrypoint)))
      .orderBy(desc(learning_session.created_at), desc(learning_session.id));
    if (existing.some((row) => row.status === 'completed')) return { kind: 'skip' };
    const live = existing.find((row) => row.status === 'started' || row.status === 'paused');
    const sessionId =
      live?.id ??
      (
        await startReviewSession(tx, {
          entrypoint,
          startedAt: await earliestDailyStreamAnswerAt(tx, date),
        })
      ).sessionId;
    const transition = await transitionReviewSessionState(tx, sessionId, 'completed');
    return transition.changed ? { kind: 'summarize', sessionId } : { kind: 'skip' };
  });
}

export async function completeDailyStreamIfDone(db: Db, row: StreamItemRow): Promise<void> {
  if (row.session_id || row.status !== 'done') return;
  try {
    if ((await openDailyItemCount(db, row.date)) !== 0) return;
    const closed = await closeDailyStream(db, row.date);
    if (closed.kind === 'summarize') await enqueueReviewSessionSummary(closed.sessionId);
  } catch (err) {
    console.error('[stream-store] daily stream completion failed (best-effort)', {
      date: row.date,
      streamItemId: row.id,
      err,
    });
  }
}
