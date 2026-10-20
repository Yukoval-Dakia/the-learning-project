// YUK-1622 — read the inputs of the daily review plan.
//
// The plan itself is pure (`@/core/daily-review-plan`); this module only joins
// the three facts it needs: the actionable due queue, the learner's minute
// budget, and the measured (or default) question pace. Coach's nightly job is
// the live consumer; the practice stream reads the same pace for its estimate.

import type { SubjectDueCount } from '@/core/daily-review-plan';
import type { Db, Tx } from '@/db/client';
import { batchResolveSubjectIds } from '@/kernel/read-models/subject-resolution';
import { REVIEW_DUE_LIMIT_MAX, queryReviewDue } from './due-list';
import { readQuestionPace } from './question-pace';
import { resolveDailyPracticeBudget } from './stream-inputs';

type DbLike = Db | Tx;

export interface DailyReviewPlanInputs {
  due_count: number;
  due_by_subject: SubjectDueCount[];
  budget_minutes: number;
  question_minutes: number;
  question_minutes_source: 'observed' | 'default';
  question_minutes_sample_count: number;
}

export async function resolveDailyReviewPlanInputs(
  db: DbLike,
  now: Date = new Date(),
): Promise<DailyReviewPlanInputs> {
  const [{ rows }, budget, pace] = await Promise.all([
    queryReviewDue(db, { limit: REVIEW_DUE_LIMIT_MAX, now }),
    resolveDailyPracticeBudget(db),
    readQuestionPace(db, now),
  ]);

  const seen = new Set<string>();
  const dueRows = rows.filter((row) => {
    if (seen.has(row.question_id)) return false;
    seen.add(row.question_id);
    return true;
  });
  const subjectByQuestion = await batchResolveSubjectIds(
    db,
    dueRows.map((row) => ({ id: row.question_id, knowledge_ids: row.knowledge_ids ?? [] })),
  );
  const dueBySubject = new Map<string, number>();
  for (const row of dueRows) {
    const subjectId = subjectByQuestion.get(row.question_id);
    if (!subjectId) continue;
    dueBySubject.set(subjectId, (dueBySubject.get(subjectId) ?? 0) + 1);
  }

  return {
    due_count: dueRows.length,
    due_by_subject: [...dueBySubject.entries()]
      .map(([subject_id, due_count]) => ({ subject_id, due_count }))
      .sort((a, b) => a.subject_id.localeCompare(b.subject_id)),
    budget_minutes: budget.minutes,
    question_minutes: pace.minutes,
    question_minutes_source: pace.source,
    question_minutes_sample_count: pace.sample_count,
  };
}
