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
 * Per-outcome attempt totals for one question, derived from the attempt
 * timeline (mirrors context-readers.ts ~:599-:604, same windowed query). Plain
 * db-taking helper — no ToolContext (PIN 7). NOTE: `getQuestionTimeline` is
 * windowed to its default (most-recent ≤10 attempt+review entries), so these are
 * totals over that recent window, not the question's lifetime — faithful to the
 * mirrored reference and ample for the N=3 (=`TEACHING_CORRECTIVE_FAILURE_N`)
 * corrective trigger. `failure` here is a total, not a consecutive streak.
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
 * Resolve the active question id for a teaching session + its cumulative attempt
 * counts. The active question is the most recently created `teaching_check`
 * question whose metadata links it to this session. Returns a null id (and null
 * counts) when the session has no teaching_check question yet.
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
