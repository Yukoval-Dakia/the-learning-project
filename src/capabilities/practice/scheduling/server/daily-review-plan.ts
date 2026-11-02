// Practice-owned facts for the kernel daily-review-plan projection.
// The plan numbers stay pure in `@/core/daily-review-plan`. This module only
// reads the three facts that projection joins: the actionable due queue, the
// learner's minute budget, and the measured (or default) question pace.

import type { Db, Tx } from '@/db/client';
import type { DailyReviewPlanFacts } from '@/kernel/read-models/daily-review-plan';
import { REVIEW_DUE_LIMIT_MAX, queryReviewDue } from './due-list';
import { readQuestionPace } from './question-pace';
import { resolveDailyPracticeBudget } from './stream-inputs';

type DbLike = Db | Tx;

export async function readDailyReviewPlanFacts(
  db: DbLike,
  now: Date,
): Promise<DailyReviewPlanFacts> {
  const [{ rows }, budget, pace] = await Promise.all([
    queryReviewDue(db, { limit: REVIEW_DUE_LIMIT_MAX, now }),
    resolveDailyPracticeBudget(db),
    readQuestionPace(db, now),
  ]);
  return {
    due_rows: rows,
    budget_minutes: budget.minutes,
    question_minutes: pace.minutes,
    question_minutes_source: pace.source,
    question_minutes_sample_count: pace.sample_count,
  };
}
