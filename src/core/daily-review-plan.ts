// YUK-1622 — single source for the daily review plan's numbers.
//
// Coach's TodayPlan and the practice stream both read this module, so YUK-1422's
// "budget / 2" quota and YUK-1424's stream estimate are one formula rather than
// two drifting ones. The model owns prose and suggestions; it never computes
// these numbers.

/**
 * Minutes assumed for one question until the learner has measured attempts.
 * This is YUK-622's 2-minute question estimate — the same value that makes a
 * 20-minute budget a 10-question day.
 */
export const DEFAULT_QUESTION_MINUTES = 2;

/** Guard rails for a measured pace: a sub-30s or 10min+ mean is treated as noise. */
export const MIN_QUESTION_MINUTES = 0.5;
export const MAX_QUESTION_MINUTES = 10;

export interface SubjectDueCount {
  subject_id: string;
  due_count: number;
}

export interface ReviewPlanNumbers {
  count: number;
  estimated_minutes: number;
  time_box_minutes: number;
  /** Planned question count per subject; weights sum to `count`. */
  subject_mix: Array<{ subject_id: string; weight: number }>;
}

export interface ReviewPlanInput {
  budget_minutes: number;
  question_minutes: number;
  /** Complete due distribution; every due question has one subject bucket. */
  due_by_subject: readonly SubjectDueCount[];
}

function wholeNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

export function normalizeQuestionMinutes(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_QUESTION_MINUTES;
  }
  return Math.min(MAX_QUESTION_MINUTES, Math.max(MIN_QUESTION_MINUTES, value));
}

/**
 * Collapse the due rows into one bucket per subject. Counts are whole
 * non-negative numbers so the denominator is the same value the caller sees.
 */
function normalizeDueBySubject(dueBySubject: readonly SubjectDueCount[]): Map<string, number> {
  const bySubject = new Map<string, number>();
  for (const row of dueBySubject) {
    const due = wholeNonNegative(row.due_count);
    if (!row.subject_id || due === 0) continue;
    bySubject.set(row.subject_id, (bySubject.get(row.subject_id) ?? 0) + due);
  }
  return bySubject;
}

/**
 * Allocate `count` seats across subjects proportional to their due counts.
 * Largest remainder keeps the result deterministic: ties break by due count,
 * then subject id, so the same input always yields the same mix.
 */
function allocateSubjectMix(
  count: number,
  dueBySubject: Map<string, number>,
  totalDue: number,
): ReviewPlanNumbers['subject_mix'] {
  if (count <= 0 || totalDue <= 0) return [];
  const shares = [...dueBySubject.entries()].map(([subjectId, due]) => {
    const exact = (due * count) / totalDue;
    return {
      subject_id: subjectId,
      due_count: due,
      weight: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  let left = count - shares.reduce((sum, share) => sum + share.weight, 0);
  const byRemainder = [...shares].sort(
    (a, b) =>
      b.remainder - a.remainder ||
      b.due_count - a.due_count ||
      a.subject_id.localeCompare(b.subject_id),
  );
  for (const share of byRemainder) {
    if (left <= 0) break;
    share.weight += 1;
    left -= 1;
  }
  return shares
    .filter((share) => share.weight > 0)
    .map(({ subject_id, weight }) => ({ subject_id, weight }))
    .sort((a, b) => b.weight - a.weight || a.subject_id.localeCompare(b.subject_id));
}

export function computeReviewPlanNumbers(input: ReviewPlanInput): ReviewPlanNumbers {
  const budgetMinutes = wholeNonNegative(input.budget_minutes);
  const questionMinutes = normalizeQuestionMinutes(input.question_minutes);
  const dueBySubject = normalizeDueBySubject(input.due_by_subject);
  const dueCount = [...dueBySubject.values()].reduce((sum, due) => sum + due, 0);
  const count = Math.min(dueCount, Math.floor(budgetMinutes / questionMinutes));
  const estimatedMinutes = Math.round(count * questionMinutes);
  return {
    count,
    estimated_minutes: estimatedMinutes,
    time_box_minutes: estimatedMinutes,
    subject_mix: allocateSubjectMix(count, dueBySubject, dueCount),
  };
}
