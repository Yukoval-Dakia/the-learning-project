// Shared projection of the inputs `@/core/daily-review-plan` turns into
// counts and minutes. Practice still owns the due queue, the minute budget
// and the measured pace, and installs that reader: this module cannot import
// a capability.

import type { SubjectDueCount } from '@/core/daily-review-plan';
import type { Db, Tx } from '@/db/client';
import { batchResolveSubjectIds } from '@/kernel/read-models/subject-resolution';
import { resolveSubjectProfile } from '@/subjects/profile';

type DbLike = Db | Tx;

export interface DailyReviewPlanDueRow {
  question_id: string;
  knowledge_ids?: readonly string[] | null;
}

export interface DailyReviewPlanFacts {
  due_rows: readonly DailyReviewPlanDueRow[];
  budget_minutes: number;
  question_minutes: number;
  question_minutes_source: 'observed' | 'default';
  question_minutes_sample_count: number;
}

export interface DailyReviewPlanInputs {
  due_count: number;
  due_by_subject: SubjectDueCount[];
  budget_minutes: number;
  question_minutes: number;
  question_minutes_source: 'observed' | 'default';
  question_minutes_sample_count: number;
}

export type ReadDailyReviewPlanFacts = (db: DbLike, now: Date) => Promise<DailyReviewPlanFacts>;

let readFacts: ReadDailyReviewPlanFacts | undefined;

export function installDailyReviewPlanFactReader(reader: ReadDailyReviewPlanFacts): void {
  readFacts = reader;
}

export async function resolveDailyReviewPlanInputs(
  db: DbLike,
  now: Date = new Date(),
): Promise<DailyReviewPlanInputs> {
  const reader = readFacts;
  if (!reader) {
    throw new Error(
      'daily review plan facts are not installed; call installDailyReviewPlanFacts before Coach reads the plan',
    );
  }
  const facts = await reader(db, now);
  const seen = new Set<string>();
  const dueRows = facts.due_rows.filter((row) => {
    if (seen.has(row.question_id)) return false;
    seen.add(row.question_id);
    return true;
  });
  const subjectByQuestion = await batchResolveSubjectIds(
    db,
    dueRows.map((row) => ({
      id: row.question_id,
      knowledge_ids: [...(row.knowledge_ids ?? [])],
    })),
  );
  // Every due question must land in one bucket: otherwise the mix denominator
  // would leave unresolved questions out and over-allocate to resolved subjects.
  const fallbackSubjectId = resolveSubjectProfile(null).id;
  const dueBySubject = new Map<string, number>();
  for (const row of dueRows) {
    const subjectId = subjectByQuestion.get(row.question_id) ?? fallbackSubjectId;
    dueBySubject.set(subjectId, (dueBySubject.get(subjectId) ?? 0) + 1);
  }
  const dueBySubjectRows = [...dueBySubject.entries()]
    .map(([subject_id, due_count]) => ({ subject_id, due_count }))
    .sort((a, b) => a.subject_id.localeCompare(b.subject_id));

  return {
    due_count: dueBySubjectRows.reduce((sum, row) => sum + row.due_count, 0),
    due_by_subject: dueBySubjectRows,
    budget_minutes: facts.budget_minutes,
    question_minutes: facts.question_minutes,
    question_minutes_source: facts.question_minutes_source,
    question_minutes_sample_count: facts.question_minutes_sample_count,
  };
}
