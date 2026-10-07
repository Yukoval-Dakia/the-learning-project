import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';

import type { MistakeProjection } from '@/capabilities/ingestion/public';
import {
  type FailureAttempt,
  getFailureAttemptById,
  getFailureAttempts,
} from '@/capabilities/knowledge/public';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { learnerVisibleKnowledgeIds } from '@/kernel/read-models/learner-knowledge-visibility';
import { miscCauseLabelMap, resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';
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

const QUESTION_CONTEXT_FIELDS = {
  id: question.id,
  prompt_md: question.prompt_md,
  reference_md: question.reference_md,
  parent_question_id: question.parent_question_id,
  created_at: question.created_at,
  updated_at: question.updated_at,
};
type QuestionContextRow = Pick<typeof question.$inferSelect, keyof typeof QUESTION_CONTEXT_FIELDS>;

function historicalQuestionText(
  failure: FailureAttempt,
  questionById: ReadonlyMap<string, QuestionContextRow>,
  editsByQuestionId: ReadonlyMap<string, Date[]>,
): Pick<MistakeProjection, 'prompt_md' | 'reference_md'> {
  const unavailable = { prompt_md: '', reference_md: null };
  // Present but invalid/unsupported evidence is not a legacy absence.
  if (failure.question_snapshot === null) return unavailable;
  if (failure.question_snapshot !== undefined) {
    const { question: frozen, parent_question: parent } = failure.question_snapshot;
    return {
      prompt_md: [parent?.prompt_md, frozen.prompt_md].filter(Boolean).join('\n\n').slice(0, 200),
      reference_md: frozen.reference_md?.slice(0, 200) ?? null,
    };
  }
  const live = questionById.get(failure.question_id);
  if (!live) return unavailable;
  const parent = live.parent_question_id ? questionById.get(live.parent_question_id) : undefined;
  if (live.parent_question_id !== null && !parent) return unavailable;
  const unchangedSinceAttempt = (row: QuestionContextRow): boolean =>
    row.created_at <= failure.created_at &&
    !(row.updated_at > row.created_at && row.updated_at >= failure.created_at) &&
    !(editsByQuestionId.get(row.id) ?? []).some((editedAt) => editedAt >= failure.created_at);
  if (!unchangedSinceAttempt(live) || (parent && !unchangedSinceAttempt(parent)))
    return unavailable;
  return {
    prompt_md: [parent?.prompt_md, live.prompt_md].filter(Boolean).join('\n\n').slice(0, 200),
    reference_md: live.reference_md?.slice(0, 200) ?? null,
  };
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
): Promise<MistakeProjection[]> {
  if (records.length === 0) return [];

  const attemptIds = new Set(
    records
      .map((record) => record.attempt_event_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const questionIds = [
    ...new Set(
      records.map((record) => record.question_id).filter((id): id is string => id !== null),
    ),
  ];
  const failures = await getFailureAttempts(db, {
    limit: Math.max(filter.limit * 4, 100),
    questionIds,
    since: filter.since,
  });
  const failureByAttempt = new Map(failures.map((failure) => [failure.attempt_event_id, failure]));
  // A record cursor can point past this question's newest failure window. Resolve
  // only missing page identities rather than dropping old records or widening the scan.
  const missingAttempts = [...attemptIds].filter((id) => !failureByAttempt.has(id));
  const missingAttemptRows =
    missingAttempts.length > 0
      ? await db
          .select({ id: event.id })
          .from(event)
          .where(
            and(
              inArray(event.id, missingAttempts),
              inArray(event.action, ['attempt', 'experimental:assessment_attempt']),
              eq(event.subject_kind, 'question'),
              questionIds.length > 0 ? inArray(event.subject_id, questionIds) : undefined,
              filter.since ? gte(event.created_at, filter.since) : undefined,
            ),
          )
      : [];
  for (const failure of await Promise.all(
    missingAttemptRows.map(({ id }) => getFailureAttemptById(db, id)),
  )) {
    if (failure) failureByAttempt.set(failure.attempt_event_id, failure);
  }
  const legacyFailures = [...failureByAttempt.values()].filter(
    (failure) =>
      attemptIds.has(failure.attempt_event_id) && failure.question_snapshot === undefined,
  );
  const legacyQuestionIds = [...new Set(legacyFailures.map((failure) => failure.question_id))];
  const questions =
    legacyQuestionIds.length > 0
      ? await db
          .select(QUESTION_CONTEXT_FIELDS)
          .from(question)
          .where(inArray(question.id, legacyQuestionIds))
      : [];
  const parentIds = [
    ...new Set(
      questions.map((row) => row.parent_question_id).filter((id): id is string => id !== null),
    ),
  ];
  const parents =
    parentIds.length > 0
      ? await db
          .select(QUESTION_CONTEXT_FIELDS)
          .from(question)
          .where(inArray(question.id, parentIds))
      : [];
  const questionById = new Map([...questions, ...parents].map((row) => [row.id, row]));
  const earliestAttempt = legacyFailures.reduce<Date | null>(
    (earliest, failure) =>
      earliest === null || failure.created_at < earliest ? failure.created_at : earliest,
    null,
  );
  const contextIds = [...questionById.keys()];
  const edits =
    earliestAttempt !== null && contextIds.length > 0
      ? await db
          .select({ question_id: event.subject_id, created_at: event.created_at })
          .from(event)
          .where(
            and(
              eq(event.action, QUESTION_EDIT_ACTION),
              eq(event.subject_kind, 'question'),
              inArray(event.subject_id, contextIds),
              gte(event.created_at, earliestAttempt),
            ),
          )
      : [];
  const editsByQuestionId = new Map<string, Date[]>();
  for (const edit of edits) {
    const dates = editsByQuestionId.get(edit.question_id) ?? [];
    dates.push(edit.created_at);
    editsByQuestionId.set(edit.question_id, dates);
  }

  // YUK-1018/1020 — misc_ primary + secondary id 的 title 回填（同一批查询，
  // 批量一次，不进循环）。id 保留在 primary_category / secondary_categories，
  // 展示层用 primary_label ?? primary_category、secondary_labels[id] ?? id。
  // effectiveCause 在此一并预算，emit 循环不再重复调用。
  const causeByAttempt = new Map(
    [...failureByAttempt.entries()].map(([id, failure]) => [
      id,
      effectiveCauseForFailureAttempt(failure),
    ]),
  );
  const miscLabels = await resolveMiscCauseLabels(
    db,
    [...causeByAttempt.values()].flatMap((cause) =>
      cause ? [cause.primary_category, ...cause.secondary_categories] : [],
    ),
  );

  return records.flatMap((record) => {
    if (!record.attempt_event_id || !attemptIds.has(record.attempt_event_id)) return [];
    const failure = failureByAttempt.get(record.attempt_event_id);
    if (!failure) return [];
    const effectiveCause = causeByAttempt.get(record.attempt_event_id);
    const cause = effectiveCause
      ? {
          source: effectiveCause.source,
          primary_category: effectiveCause.primary_category,
          primary_label: miscLabels.get(effectiveCause.primary_category) ?? null,
          secondary_categories: effectiveCause.secondary_categories,
          secondary_labels: miscCauseLabelMap(miscLabels, effectiveCause.secondary_categories),
          user_notes: effectiveCause.user_notes,
          confidence: effectiveCause.confidence,
        }
      : null;
    return [
      {
        id: failure.attempt_event_id,
        record_id: record.id,
        question_id: failure.question_id,
        ...historicalQuestionText(failure, questionById, editsByQuestionId),
        wrong_answer_md: (failure.answer_md ?? '').slice(0, 200),
        wrong_answer_image_refs: failure.answer_image_refs,
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
