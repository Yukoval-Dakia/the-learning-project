import { inArray } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import { getFailureAttempts } from '@/server/events/queries';
import { listLearningRecords } from './queries';

export interface ListMistakeProjectionFilter {
  limit: number;
  since?: Date;
  questionIds?: string[];
}

export async function listMistakeProjectionRows(db: Db, filter: ListMistakeProjectionFilter) {
  const records = await listLearningRecords(db, {
    kind: ['mistake'],
    question_id: filter.questionIds?.[0],
    since: filter.since,
    limit: filter.limit,
  });
  if (records.length === 0) return [];

  const attemptIds = new Set(
    records
      .map((record) => record.attempt_event_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const questionIds = [
    ...new Set(records.map((record) => record.question_id).filter(Boolean)),
  ] as string[];
  const failures = await getFailureAttempts(db, {
    limit: Math.max(filter.limit * 4, 100),
    questionIds,
    since: filter.since,
  });
  const failureByAttempt = new Map(failures.map((failure) => [failure.attempt_event_id, failure]));
  const questions =
    questionIds.length > 0
      ? await db
          .select({ id: question.id, prompt_md: question.prompt_md })
          .from(question)
          .where(inArray(question.id, questionIds))
      : [];
  const promptByQid = new Map(questions.map((q) => [q.id, q.prompt_md]));

  return records.flatMap((record) => {
    if (!record.attempt_event_id || !attemptIds.has(record.attempt_event_id)) return [];
    const failure = failureByAttempt.get(record.attempt_event_id);
    if (!failure) return [];
    const effectiveCause = effectiveCauseForFailureAttempt(failure);
    const cause = effectiveCause
      ? {
          source: effectiveCause.source,
          primary_category: effectiveCause.primary_category,
          secondary_categories: effectiveCause.secondary_categories,
          user_notes: effectiveCause.user_notes,
          confidence: effectiveCause.confidence,
        }
      : null;
    return [
      {
        id: failure.attempt_event_id,
        record_id: record.id,
        question_id: failure.question_id,
        prompt_md: (promptByQid.get(failure.question_id) ?? '').slice(0, 200),
        wrong_answer_md: (failure.answer_md ?? '').slice(0, 200),
        knowledge_ids: failure.referenced_knowledge_ids,
        cause,
        correction_state: failure.correction_state,
        created_at: Math.floor(failure.created_at.getTime() / 1000),
      },
    ];
  });
}
