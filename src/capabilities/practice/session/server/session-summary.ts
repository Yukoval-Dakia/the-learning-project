// SessionSummaryTask runner — practice-owned session domain operation.
// The session_summary job handler (practice/session/jobs/session_summary.ts) calls this
// after a review session completes (paper close/PATCH, KC-scoped stream completion, or
// orphan abandonment). It builds a compact stats snapshot from chained events, runs the
// task, and stores the result in learning_session.summary_md. The handler logs and
// rethrows failures so pg-boss can retry; a missing summary degrades to the UI stub.
//
// YUK-1783 (B5): the model's observation is appended verbatim — no clause
// filtering. Real counts ride the input as numeric_facts/top_causes/top_knowledge
// counts; numbers in the observation that contradict them are reported as typed
// issues on the experimental:session_summary event (agent-facing feedback, never
// an edit, never a failure). Session answers are the canonical learner-answer set
// — native assessment_attempt anchors plus legacy attempt/review rows — so paper
// sessions (交卷复盘) summarize the same way as FSRS ones.
//
// The writer is idempotent: one summary per session unless it was written while
// causes were still landing, in which case exactly one delayed refresh may rewrite
// it. Attribution that has not landed yet is a bounded wait: the job reschedules a
// few times, then writes the session numbers with causes_pending recorded. The
// event also carries the structured next_focus the coach reads the next day.

import { and, asc, desc, eq, inArray } from 'drizzle-orm';

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
import { type FailureAttempt, getFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { LEARNER_ANSWER_ACTIONS } from '@/kernel/read-models/learner-activity';
import { resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';
import { resolveSubjectProfile } from '@/subjects/profile';
import { type SessionSummaryIssue, checkSessionSummaryClaims } from './session-summary-guard';

const NOTABLE_LIMIT = 3;
const TOP_KNOWLEDGE_LIMIT = 5;
const SUMMARY_MAX_CHARS = 600;
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
  /**
   * Bounded wait for this session's failure attribution. Omitted means write now
   * with whatever causes have landed.
   */
  attributionWait?: { attempt: number; maxWaits: number };
  /**
   * The single late pass after a summary was written with causes pending. Only a
   * refresh may rewrite an existing summary; it is also the job's dedupe signal,
   * so a retried close never pays for a second model call.
   */
  refresh?: boolean;
}

export interface RunSessionSummaryResult {
  /**
   * 'written' = numbers + observation saved;
   * 'written:numbers_only' = model output had no non-statistical observation, so only
   * the deterministic server template was saved;
   * 'skipped:attribution_pending' = failures still await a real cause; the job should
   * reschedule rather than write a thin summary;
   * 'skipped:<reason>' = no-op (no session, no events).
   */
  status:
    | 'written'
    | 'written:numbers_only'
    | 'skipped:no_session'
    | 'skipped:no_events'
    | 'skipped:already_summarized'
    | 'skipped:attribution_pending';
  summary_md?: string;
  /** Observation clauses whose numbers contradict the session stats. */
  issues?: SessionSummaryIssue[];
  /** Number of effective-incorrect answers whose real cause had not landed yet. */
  pending_attribution?: number;
}

type AnswerEventRow = typeof event.$inferSelect;

interface SessionProcessSignals {
  timed_answers: number;
  median_duration_ms: number | null;
  /** Trailing answers whose duration is under half the session median; 0 when <2. */
  rushed_tail_answers: number;
  low_confidence_answers: number;
  hinted_answers: number;
  max_hint_level: number | null;
}

function payloadNumber(row: AnswerEventRow, key: string): number | null {
  const value = (row.payload as Record<string, unknown> | null)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function summarizeProcessSignals(answerEvents: AnswerEventRow[]): SessionProcessSignals {
  const durations = answerEvents
    .map((row) => payloadNumber(row, 'duration_ms'))
    .filter((value): value is number => value !== null && value > 0);
  const median = medianOf(durations);
  let rushedTail = 0;
  if (median !== null && durations.length >= 3) {
    for (let i = answerEvents.length - 1; i >= 0; i--) {
      const duration = payloadNumber(answerEvents[i], 'duration_ms');
      if (duration === null || duration <= 0 || duration * 2 >= median) break;
      rushedTail++;
    }
    if (rushedTail < 2) rushedTail = 0;
  }
  const confidence = answerEvents
    .map((row) => payloadNumber(row, 'self_confidence'))
    .filter((value): value is number => value !== null);
  const hints = answerEvents
    .map((row) => payloadNumber(row, 'hints_used'))
    .filter((value): value is number => value !== null);
  const hintLevels = answerEvents
    .map((row) => payloadNumber(row, 'final_hint_level'))
    .filter((value): value is number => value !== null);
  return {
    timed_answers: durations.length,
    median_duration_ms: median,
    rushed_tail_answers: rushedTail,
    low_confidence_answers: confidence.filter((value) => value <= 2).length,
    hinted_answers: hints.filter((value) => value > 0).length,
    max_hint_level: hintLevels.length > 0 ? Math.max(...hintLevels) : null,
  };
}

/**
 * Effective-incorrect answers whose real cause is not available yet: no judge,
 * or the chain-resolved judge is still an `attribution_pending` placeholder.
 * The flag is not part of FailureAttempt, so the raw payload is checked here.
 *
 * Only rows the failure-learning pipeline actually attributes are candidates.
 * FSRS `review` rows and `unsupported_judge` attempts never receive a chained
 * judge, so waiting on them would burn the whole window for nothing.
 */
async function findPendingAttributionIds(
  db: Db,
  candidates: AnswerEventRow[],
  failureById: Map<string, FailureAttempt>,
): Promise<Set<string>> {
  const pending = new Set<string>();
  const judgeIdByAttempt = new Map<string, string>();
  for (const row of candidates) {
    if (row.action !== 'attempt' && row.action !== NATIVE_ATTEMPT_ACTION) continue;
    if ((row.payload as { unsupported_judge?: boolean }).unsupported_judge === true) continue;
    const failure = failureById.get(row.id);
    // Not a projected failure attempt: attribution never runs for it, so its
    // cause is not "late".
    if (!failure) continue;
    if (failure.user_cause) continue;
    if (!failure.judge) {
      pending.add(row.id);
      continue;
    }
    judgeIdByAttempt.set(row.id, failure.judge.judge_event_id);
  }
  if (judgeIdByAttempt.size === 0) return pending;
  const rows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(inArray(event.id, [...new Set(judgeIdByAttempt.values())]));
  const pendingJudgeIds = new Set(
    rows
      .filter(
        (row) => (row.payload as { attribution_pending?: boolean }).attribution_pending === true,
      )
      .map((row) => row.id),
  );
  for (const [attemptId, judgeId] of judgeIdByAttempt) {
    if (pendingJudgeIds.has(judgeId)) pending.add(attemptId);
  }
  return pending;
}

function buildNextFocusReason(input: {
  knowledgeName: string;
  incorrect: number;
  causeLabel: string | null;
  rushedTail: number;
}): string {
  const cause = input.causeLabel ? `，本场主要错因是${input.causeLabel}` : '';
  const pace = input.rushedTail >= 2 ? `，末尾 ${input.rushedTail} 题用时明显偏短` : '';
  return `错得最多的是「${input.knowledgeName}」（${input.incorrect} 题）${cause}${pace}；下一场先补这里。`;
}

/**
 * Generate and persist a markdown summary for a finished review session.
 * Re-runnable: a later request (for example after a late attribution) rewrites
 * summary_md and appends a fresh provenance event. Only learner answers on this
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
    .orderBy(asc(event.created_at), asc(event.dispatch_seq));

  if (answerEvents.length === 0) {
    return { status: 'skipped:no_events' };
  }

  // A written summary is final except for two cases: it was written while causes
  // were still landing (`causes_pending`, one explicit refresh), or new answers
  // landed after it (a reopen continued the session). Everything else — a replayed
  // close or a retried refresh — returns here without paying for another model call.
  const existingSummaryRows = await db
    .select({ payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.action, SESSION_SUMMARY_EVENT_ACTION),
        eq(event.subject_kind, 'learning_session'),
        eq(event.subject_id, sessionId),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.dispatch_seq))
    .limit(1);
  const existingSummary = existingSummaryRows[0]?.payload as
    | { causes_pending?: number; attribution_refresh?: boolean }
    | undefined;
  const causesPending =
    typeof existingSummary?.causes_pending === 'number' ? existingSummary.causes_pending : null;
  // A retried refresh whose write already landed must not pay again: the newest
  // event says this session used its one late pass.
  const alreadyRefreshed = existingSummary?.attribution_refresh === true;
  // A written summary_md without a summary event is a pre-provenance session:
  // text and event commit together, so a replayed close has nothing to repair and
  // must not pay for another model call.
  const onlyStaleSummaryMd = !existingSummary && sess.summary_md !== null;
  // Answers that landed after the last summary was written mean it is stale: a
  // reopened session continues collecting answers while the old text only covers
  // the abandoned-time ones. Compare answer time to summary time, not to the
  // reopened session's started_at, so a reopen-close with no new answer does not
  // pay for an identical rewrite.
  const latestAnswerAt = answerEvents[answerEvents.length - 1]?.created_at;
  const lastSummaryAt = existingSummaryRows[0]?.created_at;
  const summaryOlderThanAnswers =
    lastSummaryAt !== undefined && latestAnswerAt !== undefined && latestAnswerAt > lastSummaryAt;
  const mayRewrite =
    summaryOlderThanAnswers ||
    (params.refresh === true && causesPending !== null && !alreadyRefreshed);
  if (!mayRewrite && (existingSummary || onlyStaleSummaryMd)) {
    return {
      status: 'skipped:already_summarized',
      // A close whose first delivery crashed before enqueuing the refresh can still
      // recover it: the follow-up id is derived from this close, so at most one
      // refresh job ever exists for it.
      ...(!alreadyRefreshed && causesPending !== null
        ? { pending_attribution: causesPending }
        : {}),
    };
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

  const knowledgeIdsFor = (r: AnswerEventRow): readonly string[] =>
    r.action === NATIVE_ATTEMPT_ACTION
      ? (nativeVerdicts.get(r.id)?.knowledge_ids ?? [])
      : ((r.payload as { referenced_knowledge_ids?: string[] }).referenced_knowledge_ids ?? []);

  // Reference count (how often the session touched a KC) and wrong count (how
  // many effective-incorrect answers named it) drive both the prompt and the
  // structured next_focus.
  const knowledgeRefCounts = new Map<string, number>();
  const knowledgeWrongCounts = new Map<string, number>();
  for (const r of answerEvents) {
    const outcome = outcomeFor(r);
    for (const id of knowledgeIdsFor(r)) {
      knowledgeRefCounts.set(id, (knowledgeRefCounts.get(id) ?? 0) + 1);
      if (outcome === 'incorrect') {
        knowledgeWrongCounts.set(id, (knowledgeWrongCounts.get(id) ?? 0) + 1);
      }
    }
  }
  const firstKnowledgeId = knowledgeRefCounts.keys().next().value as string | undefined;
  const topKnowledge = [...knowledgeRefCounts.entries()]
    .map(([id, count]) => ({ id, count, incorrect: knowledgeWrongCounts.get(id) ?? 0 }))
    .sort((a, b) => b.incorrect - a.incorrect || b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, TOP_KNOWLEDGE_LIMIT);
  const knowledgeIdsToResolve = [
    ...new Set([...(firstKnowledgeId ? [firstKnowledgeId] : []), ...topKnowledge.map((k) => k.id)]),
  ];
  const knowledgeRows = knowledgeIdsToResolve.length
    ? await db
        .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
        .from(knowledge)
        .where(inArray(knowledge.id, knowledgeIdsToResolve))
    : [];
  const knowledgeById = new Map(knowledgeRows.map((row) => [row.id, row]));
  const topKnowledgeWithNames = topKnowledge
    .map((entry) => {
      const row = knowledgeById.get(entry.id);
      // A KC row gone (merged away or never resolvable) cannot be named in the
      // prompt or handed to tomorrow's coach, so it is not offered at all.
      if (!row) return null;
      return { id: entry.id, name: row.name, count: entry.count, incorrect: entry.incorrect };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  // Subject context comes from a KC that still resolves; the raw first id may not.
  const profileKnowledgeId = topKnowledgeWithNames[0]?.id ?? firstKnowledgeId;
  const subjectProfile = resolveSubjectProfile(
    profileKnowledgeId ? (knowledgeById.get(profileKnowledgeId)?.domain ?? null) : null,
  );

  // session stats and causes both come from THIS session's effective
  // verdicts. Historical failure attribution is deliberately not mixed in.
  const effectiveOutcomeCounts = new Map<string, number>();
  const sessionFailureIds: string[] = [];
  const sessionFailureRows: AnswerEventRow[] = [];
  for (const r of answerEvents) {
    const outcome = outcomeFor(r);
    if (!outcome) continue;
    effectiveOutcomeCounts.set(outcome, (effectiveOutcomeCounts.get(outcome) ?? 0) + 1);
    if (outcome === 'incorrect') {
      sessionFailureIds.push(r.id);
      sessionFailureRows.push(r);
    }
  }

  // Reuse the shared cause policy (active user_cause wins over agent judge) but
  // only for this session's effective-incorrect reviews. The lower bound is the
  // earliest answer on the session, not started_at: reopening rebases started_at,
  // while the answers from before the reopen still count in this summary.
  const questionIds = [...new Set(answerEvents.map((r) => r.subject_id))];
  const failures = questionIds.length
    ? await getFailureAttempts(db, {
        questionIds,
        limit: null,
        includeReviewFailures: true,
        since: answerEvents[0]?.created_at,
      })
    : [];
  const failureById = new Map(failures.map((failure) => [failure.attempt_event_id, failure]));
  const pendingCauseIds = await findPendingAttributionIds(db, sessionFailureRows, failureById);
  const wait = params.attributionWait;
  if (pendingCauseIds.size > 0 && wait && wait.attempt < wait.maxWaits) {
    return {
      status: 'skipped:attribution_pending',
      pending_attribution: pendingCauseIds.size,
    };
  }
  // One effective-cause read per (non-pending) session failure; both the
  // session-wide mix and the per-knowledge mix below reuse it.
  const causeByFailureId = new Map<string, string>();
  for (const id of sessionFailureIds) {
    if (pendingCauseIds.has(id)) continue;
    const failure = failureById.get(id);
    // Success-rated reviews fall back to the judge: user_cause is currently
    // written only for sessionless manual attempts, never for these reviews.
    const category =
      (failure ? effectiveCauseForFailureAttempt(failure)?.primary_category : null) ??
      legacyVerdicts.get(id)?.effective?.verdict.cause?.primary_category;
    if (category) causeByFailureId.set(id, category);
  }
  const causeCounts = new Map<string, number>();
  const knowledgeCauseCounts = new Map<string, Map<string, number>>();
  for (const r of answerEvents) {
    const category = causeByFailureId.get(r.id);
    if (!category) continue;
    causeCounts.set(category, (causeCounts.get(category) ?? 0) + 1);
    for (const knowledgeId of knowledgeIdsFor(r)) {
      const perKnowledge = knowledgeCauseCounts.get(knowledgeId) ?? new Map<string, number>();
      perKnowledge.set(category, (perKnowledge.get(category) ?? 0) + 1);
      knowledgeCauseCounts.set(knowledgeId, perKnowledge);
    }
  }

  // misc_ labels; built-in cause labels come from the subject profile
  // so the fixed sentence never prints a raw category id.
  const causeCategoriesToLabel = new Set(causeCounts.keys());
  for (const perKnowledge of knowledgeCauseCounts.values()) {
    for (const category of perKnowledge.keys()) causeCategoriesToLabel.add(category);
  }
  const topCauseLabels = await resolveMiscCauseLabels(db, [...causeCategoriesToLabel]);
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

  const processSignals = summarizeProcessSignals(answerEvents);

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
      duration_ms?: number;
      self_confidence?: number;
      hints_used?: number;
      final_hint_level?: number;
    };
    return {
      prompt_md: qById.get(r.subject_id)?.prompt_md ?? '(题面缺失)',
      user_response_md:
        (r.action === NATIVE_ATTEMPT_ACTION ? p.response_md : p.user_response_md) ?? null,
      fsrs_rating: p.fsrs_rating ?? null,
      duration_ms: p.duration_ms ?? null,
      self_confidence: p.self_confidence ?? null,
      hints_used: p.hints_used ?? null,
      final_hint_level: p.final_hint_level ?? null,
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

  // Only a KC whose row still exists can be named in reason_md; an opaque raw id
  // is not a usable handoff for the next day's plan.
  const focusKnowledge = topKnowledgeWithNames.find((entry) => entry.incorrect > 0) ?? null;
  // The focus's own dominant cause, not the session-wide one: next_focus is a
  // per-knowledge handoff, so a different KC's cause must not label it.
  const focusCauseCategory = focusKnowledge
    ? [...(knowledgeCauseCounts.get(focusKnowledge.id)?.entries() ?? [])].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]?.[0]
    : undefined;
  const nextFocus = focusKnowledge
    ? {
        knowledge_id: focusKnowledge.id,
        knowledge_name: focusKnowledge.name,
        reason_md: buildNextFocusReason({
          knowledgeName: focusKnowledge.name,
          incorrect: focusKnowledge.incorrect,
          causeLabel: focusCauseCategory
            ? (topCauseLabels.get(focusCauseCategory) ??
              profileCauseLabels.get(focusCauseCategory) ??
              null)
            : null,
          rushedTail: processSignals.rushed_tail_answers,
        }),
      }
    : null;

  const input = {
    session_id: sessionId,
    duration_min: durationMin,
    numeric_summary: numericSummary,
    // The real session counts; the model may cite them verbatim but must not
    // compute, round or invent others.
    numeric_facts: numericFacts,
    process_signals: processSignals,
    top_causes: topCauses.map(({ category, category_label, count }) => ({
      category,
      category_label,
      count,
    })),
    top_knowledge: topKnowledgeWithNames,
    notable_attempts: notableAttempts,
  };

  const result = await runTaskFn('SessionSummaryTask', input, { subjectProfile });
  // The observation is appended verbatim; contradictory numbers become typed
  // issues on the summary event, never edits. The three-part prompt asks the model
  // to cite process signals and per-cause/per-knowledge counts, so those real
  // session readings are handed to the guard instead of reading as contradictions.
  const observation = result.text.trim();
  const relatedCounts = [
    ...new Set([
      processSignals.timed_answers,
      processSignals.rushed_tail_answers,
      processSignals.low_confidence_answers,
      processSignals.hinted_answers,
      ...topCauses.map((cause) => cause.count),
      ...topKnowledgeWithNames.flatMap((entry) => [entry.count, entry.incorrect]),
    ]),
  ];
  const issues = checkSessionSummaryClaims(observation, {
    ...numericFacts,
    related_counts: relatedCounts,
  });
  // The fixed numeric prefix is never truncated away by an over-long observation.
  const summaryMd = `${numericSummary}${observation}`.slice(0, SUMMARY_MAX_CHARS);

  const status = observation.length > 0 ? 'written' : 'written:numbers_only';

  // Provenance + contradiction issues ride one event per written summary so a
  // replay can verify the numbers and later readers can see what was flagged.
  // next_focus is the structured handoff the coach reads; causes_pending marks a
  // summary written before every cause landed. Text and event commit together: a
  // summary_md without its event reads as already summarized, so a half-written
  // pair would skip the session forever.
  await db.transaction(async (tx) => {
    await writeEvent(tx, {
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
        process_signals: processSignals,
        ...(nextFocus ? { next_focus: nextFocus } : {}),
        ...(pendingCauseIds.size > 0 ? { causes_pending: pendingCauseIds.size } : {}),
        // Marks the one allowed late rewrite so a retried refresh dedupes on read.
        ...(params.refresh === true ? { attribution_refresh: true } : {}),
        ...(issues.length > 0 ? { issues } : {}),
      },
    });

    await tx
      .update(learning_session)
      .set({ summary_md: summaryMd, updated_at: new Date() })
      .where(eq(learning_session.id, sessionId));
  });

  return {
    status,
    summary_md: summaryMd,
    ...(pendingCauseIds.size > 0 ? { pending_attribution: pendingCauseIds.size } : {}),
    ...(issues.length > 0 ? { issues } : {}),
  };
}
