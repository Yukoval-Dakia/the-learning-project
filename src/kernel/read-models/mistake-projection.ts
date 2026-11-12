import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import type { Db } from '@/db/client';
import { event, learning_record, question } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import {
  type FailureAttempt,
  getCurrentFailureAttempts,
  getFailureAttemptById,
  getFailureAttempts,
} from '@/kernel/read-models/failure-attempts';
import { learnerVisibleKnowledgeIds } from '@/kernel/read-models/learner-knowledge-visibility';
import { miscCauseLabelMap, resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';
import type { MistakeProjection } from '@/kernel/records/mistake-projection-contract';
import { readNativeMistakeEvidence } from './native-mistake-evidence';

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

async function projectMistakeFailures(
  db: Db,
  failures: FailureAttempt[],
): Promise<MistakeProjection[]> {
  if (failures.length === 0) return [];
  const attemptIds = failures.map((failure) => failure.attempt_event_id);
  const linkedRecords = await db
    .select({ id: learning_record.id, attempt_event_id: learning_record.attempt_event_id })
    .from(learning_record)
    .where(
      and(
        inArray(learning_record.attempt_event_id, attemptIds),
        eq(learning_record.kind, 'mistake'),
        isNull(learning_record.archived_at),
      ),
    );
  const recordIdByAttempt = new Map(
    linkedRecords.flatMap((row) =>
      row.attempt_event_id ? [[row.attempt_event_id, row.id] as const] : [],
    ),
  );
  const pageFailures = failures;
  const nativeEvidence = await readNativeMistakeEvidence(db, pageFailures);
  const legacyFailures = pageFailures.filter((failure) => failure.question_snapshot === undefined);
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

  // Resolve misc_ labels in one batch and precompute effective causes so the emit
  // loop does not query per row. Raw ids stay in the projection; callers fall back
  // from label to id.
  const causeByAttempt = new Map(
    pageFailures.map((failure) => [
      failure.attempt_event_id,
      effectiveCauseForFailureAttempt(failure),
    ]),
  );
  const miscLabels = await resolveMiscCauseLabels(
    db,
    [...causeByAttempt.values()].flatMap((cause) =>
      cause ? [cause.primary_category, ...cause.secondary_categories] : [],
    ),
  );

  return pageFailures.map((failure) => {
    const effectiveCause = causeByAttempt.get(failure.attempt_event_id);
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
    return {
      id: failure.attempt_event_id,
      record_id: recordIdByAttempt.get(failure.attempt_event_id) ?? '',
      question_id: failure.question_id,
      ...(nativeEvidence.get(failure.attempt_event_id) ?? {
        ...historicalQuestionText(failure, questionById, editsByQuestionId),
        prompt_materials: [],
        wrong_answer_md: (failure.answer_md ?? '').slice(0, 200),
        wrong_answer_image_refs: failure.answer_image_refs,
      }),
      knowledge_ids: learnerVisibleKnowledgeIds(failure.referenced_knowledge_ids),
      cause,
      correction_state: failure.correction_state,
      created_at: Math.floor(failure.created_at.getTime() / 1000),
    };
  });
}

function isOlderThanCursor(failure: FailureAttempt, cursor: MistakeCursor): boolean {
  const at = failure.created_at.getTime();
  const cursorAt = cursor.createdAt.getTime();
  if (at !== cursorAt) return at < cursorAt;
  return failure.attempt_event_id < cursor.id;
}

/** Mistake records keep their attempt even after a later correct grade. */
async function failuresForMistakeRecords(
  db: Db,
  records: ReadonlyArray<{ attempt_event_id: string | null; question_id: string | null }>,
  filter: ListMistakeProjectionFilter,
): Promise<FailureAttempt[]> {
  const attemptIds = [
    ...new Set(
      records.flatMap((record) => (record.attempt_event_id ? [record.attempt_event_id] : [])),
    ),
  ];
  if (attemptIds.length === 0) return [];
  const questionIds = [
    ...new Set(records.flatMap((record) => (record.question_id ? [record.question_id] : []))),
  ];
  const found = await getFailureAttempts(db, {
    ...(questionIds.length > 0 ? { questionIds } : {}),
    since: filter.since,
    limit: null,
  });
  const byId = new Map(found.map((failure) => [failure.attempt_event_id, failure]));
  const missing = attemptIds.filter((id) => !byId.has(id));
  for (const failure of await Promise.all(missing.map((id) => getFailureAttemptById(db, id)))) {
    if (failure) byId.set(failure.attempt_event_id, failure);
  }
  return attemptIds.flatMap((id) => {
    const failure = byId.get(id);
    return failure ? [failure] : [];
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
  if (questionIds && questionIds.length === 0) return { rows: [], next_cursor: null };
  const recordRows = await db
    .select({
      id: learning_record.id,
      attempt_event_id: learning_record.attempt_event_id,
      question_id: learning_record.question_id,
    })
    .from(learning_record)
    .where(
      and(
        eq(learning_record.kind, 'mistake'),
        isNull(learning_record.archived_at),
        questionIds ? inArray(learning_record.question_id, questionIds) : undefined,
        filter.since ? gte(learning_record.created_at, filter.since) : undefined,
      ),
    );
  const recordIdByAttempt = new Map(
    recordRows.flatMap((row) =>
      row.attempt_event_id ? [[row.attempt_event_id, row.id] as const] : [],
    ),
  );
  const archivedAttemptIds = new Set(
    (
      await db
        .select({ attempt_event_id: learning_record.attempt_event_id })
        .from(learning_record)
        .where(
          and(
            eq(learning_record.kind, 'mistake'),
            isNotNull(learning_record.archived_at),
            isNotNull(learning_record.attempt_event_id),
          ),
        )
    ).flatMap((row) => (row.attempt_event_id ? [row.attempt_event_id] : [])),
  );
  const historical = await failuresForMistakeRecords(db, recordRows, filter);
  const nativeOnly = (
    await getCurrentFailureAttempts(db, {
      ...(questionIds ? { questionIds } : {}),
      since: filter.since,
      limit: null,
    })
  ).filter(
    (failure) =>
      failure.assessment !== undefined &&
      !recordIdByAttempt.has(failure.attempt_event_id) &&
      !archivedAttemptIds.has(failure.attempt_event_id),
  );
  const visible = [...historical, ...nativeOnly].sort(
    (a, b) =>
      b.created_at.getTime() - a.created_at.getTime() ||
      b.attempt_event_id.localeCompare(a.attempt_event_id),
  );
  const paged = cursor ? visible.filter((failure) => isOlderThanCursor(failure, cursor)) : visible;
  const hasMore = paged.length > filter.limit;
  const page = hasMore ? paged.slice(0, filter.limit) : paged;
  const last = page.at(-1);
  return {
    rows: await projectMistakeFailures(db, page),
    next_cursor:
      hasMore && last
        ? encodeMistakeCursor({ created_at: last.created_at, id: last.attempt_event_id })
        : null,
  };
}

export async function listMistakeProjectionRows(db: Db, filter: ListMistakeProjectionFilter) {
  return (await listMistakeProjectionPage(db, filter)).rows;
}
