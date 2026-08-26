import { inArray, or, sql } from 'drizzle-orm';

import { getFailureAttempts } from '@/capabilities/knowledge/public';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { learnerVisibleKnowledgeIds } from '@/kernel/read-models/learner-knowledge-visibility';
import { listLearningRecords } from '@/kernel/records/queries';

export interface ListMistakeProjectionFilter {
  limit: number;
  since?: Date;
  questionIds?: string[];
  subjectKnowledgeIds?: string[];
  cursor?: string;
}

interface MistakeCursor {
  createdAt: Date;
  id: string;
}

function encodeMistakeCursor(record: { created_at: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ created_at: record.created_at.toISOString(), id: record.id }),
  ).toString('base64url');
}

function decodeMistakeCursor(cursor: string): MistakeCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      created_at?: unknown;
      id?: unknown;
    };
    if (typeof parsed.created_at !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('missing created_at or id');
    }
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid created_at');
    return { createdAt, id: parsed.id };
  } catch (err) {
    throw new ApiError('invalid_cursor', `invalid mistake cursor: ${(err as Error).message}`, 400);
  }
}

async function projectMistakeRecords(
  db: Db,
  records: Awaited<ReturnType<typeof listLearningRecords>>,
  filter: ListMistakeProjectionFilter,
) {
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
          .select({
            id: question.id,
            prompt_md: question.prompt_md,
            reference_md: question.reference_md,
          })
          .from(question)
          .where(inArray(question.id, questionIds))
      : [];
  const questionById = new Map(questions.map((row) => [row.id, row]));

  return records.flatMap((record) => {
    if (!record.attempt_event_id || !attemptIds.has(record.attempt_event_id)) return [];
    const failure = failureByAttempt.get(record.attempt_event_id);
    if (!failure) return [];
    const questionRow = questionById.get(failure.question_id);
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
        prompt_md: (questionRow?.prompt_md ?? '').slice(0, 200),
        reference_md: questionRow?.reference_md?.slice(0, 200) ?? null,
        wrong_answer_md: (failure.answer_md ?? '').slice(0, 200),
        knowledge_ids: learnerVisibleKnowledgeIds(failure.referenced_knowledge_ids),
        cause,
        correction_state: failure.correction_state,
        created_at: Math.floor(failure.created_at.getTime() / 1000),
      },
    ];
  });
}

export async function listMistakeProjectionPage(db: Db, filter: ListMistakeProjectionFilter) {
  const cursor = filter.cursor ? decodeMistakeCursor(filter.cursor) : null;
  const subjectQuestionIds =
    filter.subjectKnowledgeIds === undefined
      ? undefined
      : filter.subjectKnowledgeIds.length === 0
        ? []
        : (
            await db
              .select({ id: question.id })
              .from(question)
              .where(
                or(
                  ...filter.subjectKnowledgeIds.map(
                    (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
                  ),
                ),
              )
          ).map((row) => row.id);
  const questionIds =
    filter.questionIds === undefined || subjectQuestionIds === undefined
      ? (filter.questionIds ?? subjectQuestionIds)
      : filter.questionIds.filter((id) => subjectQuestionIds.includes(id));
  const fetchedRecords = await listLearningRecords(db, {
    kind: ['mistake'],
    question_id: questionIds?.length === 1 ? questionIds[0] : undefined,
    question_ids: questionIds?.length !== 1 ? questionIds : undefined,
    since: filter.since,
    before_created_at: cursor?.createdAt,
    before_id: cursor?.id,
    limit: filter.limit + 1,
  });
  const hasMore = fetchedRecords.length > filter.limit;
  const records = hasMore ? fetchedRecords.slice(0, filter.limit) : fetchedRecords;
  const last = records.at(-1);
  return {
    rows: await projectMistakeRecords(db, records, filter),
    next_cursor: hasMore && last ? encodeMistakeCursor(last) : null,
  };
}

export async function listMistakeProjectionRows(db: Db, filter: ListMistakeProjectionFilter) {
  return (await listMistakeProjectionPage(db, filter)).rows;
}
