// SessionSummaryTask runner.
//
// The session_summary handler calls this after a review session completes. It
// builds a compact stats snapshot from chained events, runs the task, and stores
// the result in learning_session.summary_md. Errors are the caller's to swallow;
// a missing summary degrades to the UI stub.

import { and, asc, eq, inArray } from 'drizzle-orm';

import { getFailureAttempts } from '@/capabilities/knowledge/public';
import type { Db } from '@/db/client';
import { event, knowledge, learning_session, question } from '@/db/schema';
import { resolveVerdictsForAttempts } from '@/kernel/read-models/assessment-verdict';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { resolveSubjectProfile } from '@/subjects/profile';

const NOTABLE_LIMIT = 3;
const MODEL_STATISTIC_CLAIMS = [
  /%|百分之/u,
  /(?:题数|正确率|错误率|准确率|得分率|通过率)(?:为|是|约|仅|只有|达到|[:：=])*[\d零〇一二两三四五六七八九十百千万半几]/u,
  /(?<![第这那每\d零〇一二两三四五六七八九十百千万半几])[\d零〇一二两三四五六七八九十百千万半几]+(?:[.点]\d+)?(?:题|道(?=题|没做完|未完成|答[对错]|[对错])|成(?=没对|正确|错误|答[对错]|的?题))/u,
];

/**
 * YUK-1621 — deterministic session numbers. Only the effective verdict track is
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

export type RunTaskFn = TaskTextRunFn;

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
}

/**
 * Generate and persist a short markdown summary for a finished review session.
 * Idempotent: skips when summary_md is already set. Only review events on this
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

  const reviewEvents = await db
    .select({
      id: event.id,
      subject_id: event.subject_id,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.action, 'review'),
        eq(event.subject_kind, 'question'),
      ),
    )
    .orderBy(asc(event.created_at));

  if (reviewEvents.length === 0) {
    return { status: 'skipped:no_events' };
  }

  const knowledgeCounts = new Map<string, number>();
  for (const r of reviewEvents) {
    const payload = r.payload as { referenced_knowledge_ids?: string[] };
    for (const k of payload.referenced_knowledge_ids ?? []) {
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

  // YUK-1621 — session stats and causes both come from THIS session's effective
  // verdicts. Historical failure attribution is deliberately not mixed in.
  const verdictMap = await resolveVerdictsForAttempts(
    db,
    reviewEvents.map((r) => r.id),
  );
  const effectiveOutcomeCounts = new Map<string, number>();
  const sessionFailureIds: string[] = [];
  for (const [id, verdict] of verdictMap) {
    const effective = verdict.effective?.verdict;
    if (!effective?.coarse_outcome) continue;
    const outcome = effective.coarse_outcome;
    effectiveOutcomeCounts.set(outcome, (effectiveOutcomeCounts.get(outcome) ?? 0) + 1);
    if (outcome === 'incorrect') sessionFailureIds.push(id);
  }

  // Reuse the shared cause policy (active user_cause wins over agent judge) but
  // only for this session's effective-incorrect reviews.
  const questionIds = [...new Set(reviewEvents.map((review) => review.subject_id))];
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
      verdictMap.get(id)?.effective?.verdict.cause?.primary_category;
    if (category) causeCounts.set(category, (causeCounts.get(category) ?? 0) + 1);
  }

  // YUK-1018 — misc_ labels; built-in cause labels come from the subject profile
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

  // Session statistics belong to this template; observations may still name
  // numbered chapters, questions or mathematical concepts.
  const numericSummary = renderSessionNumericSummary({
    total_reviewed: reviewEvents.length,
    effective_outcomes: Object.fromEntries(effectiveOutcomeCounts),
    primary_cause: topCauses[0]?.category_label?.trim() || null,
  });

  const notable = reviewEvents
    .filter((r) => {
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
    const p = r.payload as { fsrs_rating?: string; user_response_md?: string | null };
    return {
      prompt_md: qById.get(r.subject_id)?.prompt_md ?? '(题面缺失)',
      user_response_md: p.user_response_md ?? null,
      fsrs_rating: p.fsrs_rating ?? null,
    };
  });

  const durationMin =
    sess.ended_at && sess.started_at
      ? Math.round((sess.ended_at.getTime() - sess.started_at.getTime()) / 60_000)
      : null;

  const input = {
    session_id: sessionId,
    duration_min: durationMin,
    numeric_summary: numericSummary,
    // Counts stay server-side; the model only needs the ranked, labeled causes.
    top_causes: topCauses.map(({ category, category_label }) => ({ category, category_label })),
    top_knowledge: topKnowledge.map(({ id }) => ({ id })),
    notable_attempts: notableAttempts,
  };

  const result = await runTaskFn('SessionSummaryTask', input, { subjectProfile });
  // Filter statistical clauses, not numerals in topic names or chapter references.
  const observation = (result.text.match(/[^，,、。！？!?；;\n]+[，,、。！？!?；;\n]*/gu) ?? [])
    .filter((clause) => {
      const normalized = clause.normalize('NFKC').replace(/\s+/gu, '');
      return !MODEL_STATISTIC_CLAIMS.some((claim) => claim.test(normalized));
    })
    .join('')
    .trim();
  // The fixed numeric prefix is never truncated away by an over-long observation.
  const summaryMd = `${numericSummary}${observation}`.slice(0, 240);

  await db
    .update(learning_session)
    .set({ summary_md: summaryMd, updated_at: new Date() })
    .where(eq(learning_session.id, sessionId));

  return {
    status: observation.length > 0 ? 'written' : 'written:numbers_only',
    summary_md: summaryMd,
  };
}
