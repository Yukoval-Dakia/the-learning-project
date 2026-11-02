// One inference when independent wrongs on a question and independent corrects
// on other admitted questions of the same KC fall in one window. The window
// length is a guess. The record is not a serving hold and does not move mastery.

import { and, eq, inArray, sql } from 'drizzle-orm';

import { SYNTHETIC_SUBJECT_ROOT_RE } from '@/capabilities/practice/public';
import { QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION } from '@/core/schema/event';
import type { Tx } from '@/db/client';
import { event, question, question_group_lifecycle } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { getNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import { type SettlementPlan, liveAppliedSettlements, loadSettlementEvents } from './settle-read';

/** Guess, pending calibration on real use. Not a serving rule. */
export const FAULTY_QUESTION_INFERENCE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const FAULTY_QUESTION_MIN_INDEPENDENT_INCORRECT = 2;
export const FAULTY_QUESTION_MIN_INDEPENDENT_CORRECT_ON_OTHERS = 2;

/** Single-learner identity shared with the forgetting ledger. */
export const FAULTY_QUESTION_INFERENCE_LEARNER_ID = 'self';

const ATTEMPT_ACTION = 'experimental:assessment_attempt';

export interface FaultyQuestionAttempt {
  attemptId: string;
  questionId: string;
  verdict: 'correct' | 'incorrect';
  occurredAtMs: number;
  /** Later settlement wins when one submission is sealed twice at the same occurrence. */
  createdMs: number;
  /** KCs this attempt measured. Goal/container ids are already removed. */
  kcIds: readonly string[];
  admitted: boolean;
}

export interface FaultyQuestionInference {
  inference: true;
  learner_id: string;
  question_id: string;
  kc_ids: string[];
  attempt_ids: { incorrect: string[]; correct: string[] };
  window: { ms: number; from: string; until: string };
}

export function faultyQuestionInferenceEventId(learnerId: string, questionId: string): string {
  return `evt_question_or_answer_may_be_faulty_${learnerId}_${questionId}`;
}

function inWindow(occurredAtMs: number, untilMs: number): boolean {
  return occurredAtMs <= untilMs && occurredAtMs > untilMs - FAULTY_QUESTION_INFERENCE_WINDOW_MS;
}

function dedupeAttempts(attempts: readonly FaultyQuestionAttempt[]): FaultyQuestionAttempt[] {
  const byId = new Map<string, FaultyQuestionAttempt>();
  for (const attempt of attempts) {
    const prev = byId.get(attempt.attemptId);
    if (
      !prev ||
      attempt.occurredAtMs > prev.occurredAtMs ||
      (attempt.occurredAtMs === prev.occurredAtMs && attempt.createdMs >= prev.createdMs)
    ) {
      byId.set(attempt.attemptId, attempt);
    }
  }
  return [...byId.values()];
}

function inferenceForQuestion(
  windowed: readonly FaultyQuestionAttempt[],
  questionId: string,
  untilMs: number,
  learnerId: string,
): FaultyQuestionInference | null {
  const incorrect = windowed.filter(
    (attempt) => attempt.questionId === questionId && attempt.verdict === 'incorrect',
  );
  if (incorrect.length < FAULTY_QUESTION_MIN_INDEPENDENT_INCORRECT) return null;
  const qualifying = [...new Set(incorrect.flatMap((attempt) => attempt.kcIds))]
    .sort()
    .map((kcId) => ({
      kcId,
      attemptIds: windowed
        .filter(
          (attempt) =>
            attempt.verdict === 'correct' &&
            attempt.admitted &&
            attempt.questionId !== questionId &&
            attempt.kcIds.includes(kcId),
        )
        .map((attempt) => attempt.attemptId),
    }))
    .filter((row) => row.attemptIds.length >= FAULTY_QUESTION_MIN_INDEPENDENT_CORRECT_ON_OTHERS);
  if (qualifying.length === 0) return null;
  const fromMs = untilMs - FAULTY_QUESTION_INFERENCE_WINDOW_MS;
  return {
    inference: true,
    learner_id: learnerId,
    question_id: questionId,
    kc_ids: qualifying.map((row) => row.kcId),
    attempt_ids: {
      incorrect: [...new Set(incorrect.map((attempt) => attempt.attemptId))].sort(),
      correct: [...new Set(qualifying.flatMap((row) => row.attemptIds))].sort(),
    },
    window: {
      ms: FAULTY_QUESTION_INFERENCE_WINDOW_MS,
      from: new Date(fromMs).toISOString(),
      until: new Date(untilMs).toISOString(),
    },
  };
}

/** Questions touched by this settlement that now meet the pattern. */
export function faultyQuestionInferences(input: {
  attempts: readonly FaultyQuestionAttempt[];
  focusQuestionId: string;
  focusKcIds: readonly string[];
  untilMs: number;
  learnerId?: string;
}): FaultyQuestionInference[] {
  const learnerId = input.learnerId ?? FAULTY_QUESTION_INFERENCE_LEARNER_ID;
  const focusKcs = new Set(input.focusKcIds);
  const windowed = dedupeAttempts(
    input.attempts.filter((attempt) => inWindow(attempt.occurredAtMs, input.untilMs)),
  );
  const suspectIds = new Set<string>();
  for (const attempt of windowed) {
    if (
      attempt.questionId === input.focusQuestionId ||
      attempt.kcIds.some((kcId) => focusKcs.has(kcId))
    ) {
      suspectIds.add(attempt.questionId);
    }
  }
  return [...suspectIds].sort().flatMap((questionId) => {
    const record = inferenceForQuestion(windowed, questionId, input.untilMs, learnerId);
    return record ? [record] : [];
  });
}

// help 'none' is sealed only when issuance assistance is independent and both
// hint counters are zero. Self-report and manual grades stay out.
function independentJudgedVerdict(plan: SettlementPlan): 'correct' | 'incorrect' | null {
  const verdict = plan.verdict?.verdict;
  if (verdict !== 'correct' && verdict !== 'incorrect') return null;
  if (plan.provenance?.source !== 'automatic' || plan.provenance.assisted === true) return null;
  const fact = plan.forgettingInput?.fact;
  if (fact?.source !== 'judged' || fact?.help !== 'none') return null;
  if ((fact?.hints_used ?? 0) !== 0 || (fact?.final_hint_level ?? 0) !== 0) return null;
  return verdict;
}

function scopeKcIdsOf(plan: SettlementPlan): string[] {
  return Array.isArray(plan.scopeKcIds) ? plan.scopeKcIds : [];
}

function contentKcIds(ids: readonly string[], nonKc: ReadonlySet<string>): string[] {
  return [
    ...new Set(
      ids.filter((id) => id.length > 0 && !nonKc.has(id) && !SYNTHETIC_SUBJECT_ROOT_RE.test(id)),
    ),
  ];
}

function assessmentAttemptId(submissionId: string): string {
  return `evt_assessment_${submissionId}`;
}

async function attemptQuestionBySubmission(
  tx: Tx,
  submissionIds: readonly string[],
): Promise<Map<string, { attemptId: string; questionId: string }>> {
  const map = new Map<string, { attemptId: string; questionId: string }>();
  if (submissionIds.length === 0) return map;
  const rows = await tx
    .select({ id: event.id, subject_id: event.subject_id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, ATTEMPT_ACTION),
        eq(event.subject_kind, 'question'),
        sql`${event.payload}->>'submission_id' in (${sql.join(
          submissionIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );
  for (const row of rows) {
    const submissionId = row.payload.submission_id;
    if (typeof submissionId !== 'string' || submissionId.length === 0) continue;
    map.set(submissionId, { attemptId: row.id, questionId: row.subject_id });
  }
  return map;
}

export async function recordFaultyItemInferences(
  tx: Tx,
  input: {
    plan: SettlementPlan;
    questionGroupId: string;
    settlementEventId: string;
    occurredAt: Date;
    activatedAt: Date;
  },
): Promise<void> {
  if (independentJudgedVerdict(input.plan) === null) return;
  const untilMs = input.occurredAt.getTime();
  if (Number.isNaN(untilMs)) return;
  const windowStart = new Date(untilMs - FAULTY_QUESTION_INFERENCE_WINDOW_MS);
  const live = liveAppliedSettlements(await loadSettlementEvents(tx, windowStart)).filter(
    (row) => !row.fsrsOnly && inWindow(row.occurrenceMs, untilMs),
  );
  const counted = live.flatMap((row) => {
    const verdict = independentJudgedVerdict(row.inputs);
    return verdict === null ? [] : [{ row, verdict }];
  });
  const submissionIds = [...new Set(counted.map((item) => item.row.inputs.submissionId))];
  const attemptBySubmission = await attemptQuestionBySubmission(tx, submissionIds);
  const questionIds = [
    ...new Set([
      input.questionGroupId,
      ...[...attemptBySubmission.values()].map((attempt) => attempt.questionId),
    ]),
  ];
  const questionRows =
    questionIds.length === 0
      ? []
      : await tx
          .select({ id: question.id, parent_question_id: question.parent_question_id })
          .from(question)
          .where(inArray(question.id, questionIds));
  const groupIdByQuestion = new Map(
    questionRows.map((row) => [row.id, row.parent_question_id ?? row.id] as const),
  );
  const groupIds = [...new Set(questionIds.map((id) => groupIdByQuestion.get(id) ?? id))];
  const lifecycleRows =
    groupIds.length === 0
      ? []
      : await tx
          .select({
            group_id: question_group_lifecycle.group_id,
            scoring_admission_state: question_group_lifecycle.scoring_admission_state,
          })
          .from(question_group_lifecycle)
          .where(inArray(question_group_lifecycle.group_id, groupIds));
  const admittedGroups = new Set(
    lifecycleRows
      .filter((row) => row.scoring_admission_state === 'admitted')
      .map((row) => row.group_id),
  );
  const rawKcIds = counted.flatMap((item) => scopeKcIdsOf(item.row.inputs));
  rawKcIds.push(...scopeKcIdsOf(input.plan));
  const nonKc = await getNonKcKnowledgeIds(tx, rawKcIds);
  const kcIdsOf = (plan: SettlementPlan) => contentKcIds(scopeKcIdsOf(plan), nonKc);
  const attempts: FaultyQuestionAttempt[] = [];
  let focusQuestionId = input.questionGroupId;
  for (const item of counted) {
    const submissionId = item.row.inputs.submissionId;
    const located = attemptBySubmission.get(submissionId);
    const isCurrent = submissionId === input.plan.submissionId;
    // A settlement with no attempt anchor cannot be pinned to a question.
    // Only the submission being settled may fall back to its group id.
    const questionId = located?.questionId ?? (isCurrent ? input.questionGroupId : undefined);
    if (!questionId) continue;
    if (isCurrent) focusQuestionId = questionId;
    const groupId = groupIdByQuestion.get(questionId) ?? questionId;
    attempts.push({
      attemptId: located?.attemptId ?? assessmentAttemptId(submissionId),
      questionId,
      verdict: item.verdict,
      occurredAtMs: item.row.occurrenceMs,
      createdMs: item.row.createdMs,
      kcIds: kcIdsOf(item.row.inputs),
      admitted: admittedGroups.has(groupId),
    });
  }
  const currentAttemptId =
    attemptBySubmission.get(input.plan.submissionId)?.attemptId ??
    assessmentAttemptId(input.plan.submissionId);
  if (!attempts.some((attempt) => attempt.attemptId === currentAttemptId)) {
    const verdict = independentJudgedVerdict(input.plan);
    const questionId =
      attemptBySubmission.get(input.plan.submissionId)?.questionId ?? input.questionGroupId;
    if (verdict) {
      focusQuestionId = questionId;
      const groupId = groupIdByQuestion.get(questionId) ?? questionId;
      attempts.push({
        attemptId: currentAttemptId,
        questionId,
        verdict,
        occurredAtMs: untilMs,
        createdMs: input.activatedAt.getTime(),
        kcIds: kcIdsOf(input.plan),
        admitted: admittedGroups.has(groupId),
      });
    }
  }
  const focusKcIds = kcIdsOf(input.plan);
  const inferences = faultyQuestionInferences({
    attempts,
    focusQuestionId,
    focusKcIds,
    untilMs,
  });
  if (inferences.length === 0) return;
  const ids = inferences.map((row) =>
    faultyQuestionInferenceEventId(row.learner_id, row.question_id),
  );
  const existing = await tx.select({ id: event.id }).from(event).where(inArray(event.id, ids));
  const have = new Set(existing.map((row) => row.id));
  for (const row of inferences) {
    const id = faultyQuestionInferenceEventId(row.learner_id, row.question_id);
    if (have.has(id)) continue;
    await writeEvent(tx, {
      id,
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'assessment_settlement',
      action: QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION,
      subject_kind: 'question',
      subject_id: row.question_id,
      outcome: null,
      payload: row,
      caused_by_event_id: input.settlementEventId,
      affected_scopes: [],
      task_run_id: null,
      cost_micro_usd: null,
      ingest_at: input.activatedAt,
      created_at: input.activatedAt,
    });
  }
}
