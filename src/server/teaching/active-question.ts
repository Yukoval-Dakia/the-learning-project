// P5.6 / YUK-178 (call-site 11, §4.3) — active-question + cumulative attempt
// counts for the teaching drawer's corrective-chip trigger.
//
// LEAN FIX (no `learning_session.active_question_id` DB column, no migration):
// the turn (POST) and GET responses carry `active_question_id` + its
// `attempt_counts`; the drawer stores them in component state. The active
// question of a teaching session is the latest `teaching_check` question the
// turn route persisted for that session (metadata.session_id, source
// 'teaching_check'). PIN 8: the failure total that drives the corrective chip is
// non-zero only on the GET poll / the turn AFTER an attempt lands — the
// question-creation turn has 0 attempts — so the GET path is the primary source.
//
// PIN 7: `getQuestionContext`'s attempt aggregate lives inside a DomainTool
// (executeGetQuestionContext needs a ToolContext) and is not callable as a
// drop-in route reader. We extract a plain `countAttemptOutcomes(db, questionId)`
// here that reuses `getQuestionTimeline` (a free db-taking query) and filters —
// mirroring context-readers.ts ~:599-:604.

import type { Db, Tx } from '@/db/client';
import { question } from '@/db/schema';
import { getQuestionTimeline } from '@/server/events/queries';
import { and, desc, eq, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

export interface AttemptOutcomeCounts {
  success: number;
  partial: number;
  failure: number;
}

export interface ActiveQuestionState {
  active_question_id: string | null;
  // Cumulative totals over the question's whole timeline (NOT consecutive).
  // Null when there is no active question for the session.
  attempt_counts: AttemptOutcomeCounts | null;
}

/**
 * Computes per-outcome attempt totals for a question from its recent attempt timeline.
 *
 * Counts are computed over the timeline window returned by `getQuestionTimeline` (the most-recent ≤10 attempt+review entries), not the question's lifetime.
 *
 * @param questionId - ID of the question whose recent attempt outcomes to tally
 * @returns The totals as an object with `success`, `partial`, and `failure` counts; `failure` is the total failures in the window (not a consecutive streak)
 */
export async function countAttemptOutcomes(
  db: DbLike,
  questionId: string,
): Promise<AttemptOutcomeCounts> {
  const timeline = await getQuestionTimeline(db, questionId);
  const counts: AttemptOutcomeCounts = { success: 0, partial: 0, failure: 0 };
  for (const entry of timeline) {
    if (entry.kind !== 'attempt') continue;
    if (entry.outcome === 'success') counts.success += 1;
    else if (entry.outcome === 'partial') counts.partial += 1;
    else counts.failure += 1;
  }
  return counts;
}

/**
 * Determine the active teaching-check question for a session and its cumulative attempt totals.
 *
 * The active question is the most recently created question whose `source` is `'teaching_check'`
 * and whose `metadata.session_id` matches the provided sessionId. If no such question exists,
 * both `active_question_id` and `attempt_counts` will be `null`.
 *
 * @returns An object where `active_question_id` is the ID of the found question (or `null` if none),
 * and `attempt_counts` contains per-outcome totals (`success`, `partial`, `failure`) for that question
 * (or `null` when `active_question_id` is `null`).
 */
export async function getActiveQuestionState(
  db: DbLike,
  sessionId: string,
): Promise<ActiveQuestionState> {
  const rows = await db
    .select({ id: question.id })
    .from(question)
    .where(
      and(
        eq(question.source, 'teaching_check'),
        sql`${question.metadata}->>'session_id' = ${sessionId}`,
      ),
    )
    .orderBy(desc(question.created_at), desc(question.id))
    .limit(1);

  const activeQuestionId = rows[0]?.id ?? null;
  if (!activeQuestionId) {
    return { active_question_id: null, attempt_counts: null };
  }
  const attemptCounts = await countAttemptOutcomes(db, activeQuestionId);
  return { active_question_id: activeQuestionId, attempt_counts: attemptCounts };
}
