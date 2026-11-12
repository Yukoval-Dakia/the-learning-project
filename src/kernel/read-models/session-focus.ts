// Cross-capability read of the last practice session's structured next focus.
//
// The practice session owner writes `experimental:session_summary` with a loose
// payload; `next_focus` rides that same record (YUK-2166: no new schema event).
// "Last session" is ordered by when the learner practised it, not by when the
// summary was written: a late refresh rewrites an older session's summary, and
// the orphan sweep stamps a fresh `ended_at` on a long-idle session. Only closed
// sessions qualify (a reopened session already has newer answers and no new
// summary yet), and if that session named no wrong knowledge point there is no
// focus rather than an older session's stale one.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event, learning_session } from '@/db/schema';

export const SESSION_SUMMARY_EVENT_ACTION = 'experimental:session_summary';
export interface SessionFocusRead {
  session_id: string;
  knowledge_id: string;
  knowledge_name: string;
  reason_md: string;
  created_at: Date;
}

/** The newest session summary's next_focus, or null before one names a focus. */
export async function readLatestSessionFocus(db: Db | Tx): Promise<SessionFocusRead | null> {
  const rows = await db
    .select({
      subject_id: event.subject_id,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .innerJoin(learning_session, eq(learning_session.id, event.subject_id))
    .where(
      and(
        eq(event.action, SESSION_SUMMARY_EVENT_ACTION),
        eq(event.subject_kind, 'learning_session'),
        inArray(learning_session.status, ['completed', 'abandoned']),
      ),
    )
    .orderBy(
      // An abandoned session's ended_at is the sweep time, not practice time;
      // fall back to its start so a long-idle session cannot outrank the session
      // the learner actually did last.
      desc(
        sql`coalesce(case when ${learning_session.status} = 'abandoned' then null else ${learning_session.ended_at} end, ${learning_session.started_at})`,
      ),
      desc(event.created_at),
      desc(event.dispatch_seq),
      desc(event.id),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const nextFocus = (row.payload as { next_focus?: unknown } | null)?.next_focus;
  if (nextFocus === null || typeof nextFocus !== 'object') return null;
  const record = nextFocus as Record<string, unknown>;
  if (typeof record.knowledge_id !== 'string' || !record.knowledge_id) return null;
  const reasonMd = typeof record.reason_md === 'string' ? record.reason_md.trim() : '';
  if (!reasonMd) return null;
  return {
    session_id: row.subject_id,
    knowledge_id: record.knowledge_id,
    knowledge_name:
      typeof record.knowledge_name === 'string' && record.knowledge_name.trim()
        ? record.knowledge_name
        : record.knowledge_id,
    reason_md: reasonMd,
    created_at: row.created_at,
  };
}
