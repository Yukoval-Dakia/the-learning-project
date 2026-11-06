// SessionSummaryTask runner — practice-owned session domain operation.
// The session_summary job handler (practice/session/jobs/session_summary.ts) calls this
// after a review session completes. It builds a compact stats snapshot from
// chained events, runs the task, and stores the result in
// learning_session.summary_md. The handler logs and rethrows failures so
// pg-boss can retry; a missing summary degrades to the UI stub.
// `getFailureAttempts` now comes from the kernel read-model directly (the
// knowledge public seam only re-exported it); the run function is the platform
// `BoundRunTaskTextFn` from `@/server/ai/runner-fn`.
//
// YUK-1783 (B5): the model's observation is appended verbatim — no clause
// filtering. Real counts ride the input as numeric_facts/top_causes/top_knowledge
// counts; numbers in the observation that contradict them are reported as typed
// issues on the experimental:session_summary event (agent-facing feedback, never
// an edit, never a failure). Session answers are the canonical learner-answer set
// — native assessment_attempt anchors plus legacy attempt/review rows — so paper
// sessions (交卷复盘) summarize the same way as FSRS ones.

import { and, asc, eq, inArray } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event, knowledge, learning_session, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import {
  nativeAttemptOutcome,
  resolveVerdictsForAttempts,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { getFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { LEARNER_ANSWER_ACTIONS } from '@/kernel/read-models/learner-activity';
import { resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';
import { resolveSubjectProfile } from '@/subjects/profile';
import { type SessionSummaryIssue, checkSessionSummaryClaims } from './session-summary-guard';

const NOTABLE_LIMIT = 3;
const NATIVE_ATTEMPT_ACTION = 'experimental:assessment_attempt';
export const SESSION_SUMMARY_EVENT_ACTION = 'experimental:session_summary';

/**
 * deterministic session numbers. Only the effective verdict track is
 * counted; unjudged reviews stay in the total but not in the accuracy denominator.
 */
export function renderSessionNumericSummary(input: {
  total_reviewed: number;
  effective_outcomes: Record<string, number>;
  primary_cause: string | null;
}): string {
  let correct = 0;
  let partial = 0;
  let incorrect = 0;
  for (const [outcome, count] of Object.entries(input.effective_outcomes)) {
    if (!Number.isFinite(count) || count <= 0) continue;
    if (outcome === 'correct') correct += count;
    else if (outcome === 'incorrect') incorrect += count;
    else if (outcome === 'partial' || outcome === 'partial_unknown') partial += count;
  }
  const graded = correct + partial + incorrect;
  if (graded === 0) return `本次复习 ${input.total_reviewed} 题，暂无有效判分。`;
  const pct = Math.round((correct / graded) * 100);
  const denominator = graded === input.total_reviewed ? '' : `（${graded} 题有效判分）`;
  const cause = input.primary_cause ? `；主要错在 ${input.primary_cause}` : '';
  return `本次复习 ${input.total_reviewed} 题，${pct}% 正确${denominator}${cause}。`;
}

export type RunTaskFn = BoundRunTaskTextFn;

export interface RunSessionSummaryParams {
  db: Db;
  sessionId: string;
  runTaskFn: RunTaskFn;
}

export interface RunSessionSummaryResult {
  /**
   * 'written' = numbers + observation saved;
   * 'written:numbers_only' = model output had no non-statistical observation, so only
   * the deterministic server template was saved;
   * 'skipped:<reason>' = no-op (already had a summary, no events, etc.).
   */
  status:
    | 'written'
    | 'written:numbers_only'
    | 'skipped:no_session'
    | 'skipped:no_events'
    | 'skipped:already_summarized';
  summary_md?: string;
  /** Observation clauses whose numbers contradict the session stats. */
  issues?: SessionSummaryIssue[];
}

type AnswerEventRow = typeof event.$inferSelect;

/**
 * Generate and persist a short markdown summary for a finished review session.
 * Idempotent: skips when summary_md is already set. Only learner answers on this
 * session_id are considered.
 */
export async function runSessionSummary(
  params: RunSessionSummaryParams,
): Promise<RunSessionSummaryResult> {
  const { db, sessionId, runTaskFn } = params;

  const sessRows = await db
    .select({
      id: learning_session.id,
      type: learning_session.type,
      status: learning_session.status,
      summary_md: learning_session.summary_md,
      started_at: learning_session.started_at,
      ended_at: learning_session.ended_at,
    })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  const sess = sessRows[0];
  if (!sess) return { status: 'skipped:no_session' };
  if (sess.summary_md) return { status: 'skipped:already_summarized' };

  const answerEvents: AnswerEventRow[] = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
        eq(event.subject_kind, 'question'),
      ),
    )
    .orderBy(asc(event.created_at));

  if (answerEvents.length === 0) {
    return { status: 'skipped:no_events' };
  }

  const nativeRows = answerEvents.filter((r) => r.action === NATIVE_ATTEMPT_ACTION);
  const legacyRows = answerEvents.filter((r) => r.action !== NATIVE_ATTEMPT_ACTION);
  const [legacyVerdicts, nativeVerdicts] = await Promise.all([
    resolveVerdictsForAttempts(
      db,
      legacyRows.map((r) => r.id),
    ),
    resolveVerdictsForNativeAttempts(db, nativeRows),
  ]);

  // Per-event effective outcome on the verdict track; null = no usable verdict
  // (unjudged, pending, self-reported, unsupported).
  const outcomeFor = (r: AnswerEventRow): string | null => {
    if (r.action === NATIVE_ATTEMPT_ACTION) {
      const outcome = nativeAttemptOutcome(nativeVerdicts.get(r.id));
      return outcome === 'success'
        ? 'correct'
        : outcome === 'failure'
          ? 'incorrect'
          : outcome === 'partial'
            ? 'partial'
            : null;
    }
    return legacyVerdicts.get(r.id)?.effective?.verdict.coarse_outcome ?? null;
  };

  const knowledgeCounts = new Map<string, number>();
  for (const r of answerEvents) {
    const knowledgeIds =
      r.action === NATIVE_ATTEMPT_ACTION
        ? (nativeVerdicts.get(r.id)?.knowledge_ids ?? [])
        : ((r.payload as { referenced_knowledge_ids?: string[] }).referenced_knowledge_ids ?? []);
    for (const k of knowledgeIds) {
      knowledgeCounts.set(k, (knowledgeCounts.get(k) ?? 0) + 1);
    }
  }
  const topKnowledge = [...knowledgeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => ({ id, count }));
  const firstKnowledgeId = knowledgeCounts.keys().next().value as string | undefined;
  const firstDomain = firstKnowledgeId
    ? (
        await db
          .select({ domain: knowledge.domain })
          .from(knowledge)
          .where(eq(knowledge.id, firstKnowledgeId))
          .limit(1)
      )[0]?.domain
    : null;
  const subjectProfile = resolveSubjectProfile(firstDomain);

  // session stats and causes both come from THIS session's effective
  // verdicts. Historical failure attribution is deliberately not mixed in.
  const effectiveOutcomeCounts = new Map<string, number>();
  const sessionFailureIds: string[] = [];
  for (const r of answerEvents) {
    const outcome = outcomeFor(r);
    if (!outcome) continue;
    effectiveOutcomeCounts.set(outcome, (effectiveOutcomeCounts.get(outcome) ?? 0) + 1);
    if (outcome === 'incorrect') sessionFailureIds.push(r.id);
  }

  // Reuse the shared cause policy (active user_cause wins over agent judge) but
  // only for this session's effective-incorrect reviews.
  const questionIds = [...new Set(answerEvents.map((r) => r.subject_id))];
  const failures = questionIds.length
    ? await getFailureAttempts(db, {
        questionIds,
        limit: null,
        includeReviewFailures: true,
        since: sess.started_at ?? undefined,
      })
    : [];
  const failureById = new Map(failures.map((failure) => [failure.attempt_event_id, failure]));
  const causeCounts = new Map<string, number>();
  for (const id of sessionFailureIds) {
    const failure = failureById.get(id);
    // Success-rated reviews fall back to the judge: user_cause is currently
    // written only for sessionless manual attempts, never for these reviews.
    const category =
      (failure ? effectiveCauseForFailureAttempt(failure)?.primary_category : null) ??
      legacyVerdicts.get(id)?.effective?.verdict.cause?.primary_category;
    if (category) causeCounts.set(category, (causeCounts.get(category) ?? 0) + 1);
  }

  // misc_ labels; built-in cause labels come from the subject profile
  // so the fixed sentence never prints a raw category id.
  const topCauseLabels = await resolveMiscCauseLabels(db, [...causeCounts.keys()]);
  const profileCauseLabels = new Map(
    subjectProfile.causeCategories.map((category) => [category.id, category.label]),
  );
  const topCauses = [...causeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([category, count]) => ({
      category,
      category_label: topCauseLabels.get(category) ?? profileCauseLabels.get(category) ?? null,
      count,
    }));

  // Session statistics belong to this template; the model may cite the same
  // numbers verbatim from numeric_facts.
  const numericSummary = renderSessionNumericSummary({
    total_reviewed: answerEvents.length,
    effective_outcomes: Object.fromEntries(effectiveOutcomeCounts),
    primary_cause: topCauses[0]?.category_label?.trim() || null,
  });

  // Model-facing text only: restricted answers still count in numeric_facts
  // (the learner's own session stats), but their response_md never leaves.
  const derivableIds = await allowedEventIds(
    db,
    answerEvents.map((r) => r.id),
  );
  const notable = answerEvents
    .filter((r) => derivableIds.has(r.id))
    .filter((r) => {
      if (r.action === NATIVE_ATTEMPT_ACTION) {
        const outcome = outcomeFor(r);
        return outcome === 'incorrect' || outcome === 'partial';
      }
      const rating = (r.payload as { fsrs_rating?: string }).fsrs_rating;
      return rating === 'again' || rating === 'hard';
    })
    .slice(0, NOTABLE_LIMIT);
  const notableQuestionIds = notable.map((r) => r.subject_id);
  const qById = new Map<string, { prompt_md: string }>();
  if (notableQuestionIds.length > 0) {
    const qrows = await db
      .select({ id: question.id, prompt_md: question.prompt_md })
      .from(question)
      .where(inArray(question.id, notableQuestionIds));
    for (const q of qrows) qById.set(q.id, { prompt_md: q.prompt_md });
  }
  const notableAttempts = notable.map((r) => {
    const p = r.payload as {
      fsrs_rating?: string;
      user_response_md?: string | null;
      response_md?: string | null;
    };
    return {
      prompt_md: qById.get(r.subject_id)?.prompt_md ?? '(题面缺失)',
      user_response_md:
        (r.action === NATIVE_ATTEMPT_ACTION ? p.response_md : p.user_response_md) ?? null,
      fsrs_rating: p.fsrs_rating ?? null,
    };
  });

  const durationMin =
    sess.ended_at && sess.started_at
      ? Math.round((sess.ended_at.getTime() - sess.started_at.getTime()) / 60_000)
      : null;

  const correctCount = effectiveOutcomeCounts.get('correct') ?? 0;
  const partialCount =
    (effectiveOutcomeCounts.get('partial') ?? 0) +
    (effectiveOutcomeCounts.get('partial_unknown') ?? 0);
  const incorrectCount = effectiveOutcomeCounts.get('incorrect') ?? 0;
  const gradedCount = correctCount + partialCount + incorrectCount;
  const numericFacts = {
    total_reviewed: answerEvents.length,
    graded: gradedCount,
    correct: correctCount,
    partial: partialCount,
    incorrect: incorrectCount,
    correct_pct: gradedCount > 0 ? Math.round((correctCount / gradedCount) * 100) : null,
    duration_min: durationMin,
  };

  const input = {
    session_id: sessionId,
    duration_min: durationMin,
    numeric_summary: numericSummary,
    // The real session counts; the model may cite them verbatim but must not
    // compute, round or invent others.
    numeric_facts: numericFacts,
    top_causes: topCauses.map(({ category, category_label, count }) => ({
      category,
      category_label,
      count,
    })),
    top_knowledge: topKnowledge.map(({ id, count }) => ({ id, count })),
    notable_attempts: notableAttempts,
  };

  const result = await runTaskFn('SessionSummaryTask', input, { subjectProfile });
  // The observation is appended verbatim; contradictory numbers become typed
  // issues on the summary event, never edits.
  const observation = result.text.trim();
  const issues = checkSessionSummaryClaims(observation, numericFacts);
  // The fixed numeric prefix is never truncated away by an over-long observation.
  const summaryMd = `${numericSummary}${observation}`.slice(0, 240);

  const status = observation.length > 0 ? 'written' : 'written:numbers_only';
  await db
    .update(learning_session)
    .set({ summary_md: summaryMd, updated_at: new Date() })
    .where(eq(learning_session.id, sessionId));

  // Provenance + contradiction issues ride one event per written summary so a
  // replay can verify the numbers and later readers can see what was flagged.
  await writeEvent(db, {
    id: newId(),
    session_id: sessionId,
    actor_kind: 'system',
    actor_ref: 'session_summary',
    action: SESSION_SUMMARY_EVENT_ACTION,
    subject_kind: 'learning_session',
    subject_id: sessionId,
    outcome: 'success',
    payload: {
      status,
      task_run_id: result.task_run_id,
      facts: numericFacts,
      ...(issues.length > 0 ? { issues } : {}),
    },
  });

  return {
    status,
    summary_md: summaryMd,
    ...(issues.length > 0 ? { issues } : {}),
  };
}
