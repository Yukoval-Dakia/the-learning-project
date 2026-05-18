import { createId } from '@paralleldrive/cuid2';
import { type SQL, and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { knowledge, learning_record } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import type {
  CreateLearningRecordInput,
  CreateLearningRecordResult,
  LearningRecordListRow,
  LearningRecordRow,
  ListLearningRecordsFilter,
  UpdateLearningRecordPatch,
} from './types';

type DbLike = Db | Tx;

async function assertKnowledgeIdsActive(db: DbLike, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const uniqueIds = [...new Set(ids)];
  const found = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(inArray(knowledge.id, uniqueIds), isNull(knowledge.archived_at)));
  const foundIds = new Set(found.map((row) => row.id));
  const missing = uniqueIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new ApiError(
      'validation_error',
      `unknown or archived knowledge_ids: ${missing.join(', ')}`,
      400,
    );
  }
}

export async function createLearningRecord(
  db: DbLike,
  input: CreateLearningRecordInput,
): Promise<CreateLearningRecordResult> {
  await assertKnowledgeIdsActive(db, input.knowledge_ids);

  const now = new Date();
  const id = input.id ?? createId();
  let originEventId = input.origin_event_id ?? null;
  let origin_event: CreateLearningRecordResult['origin_event'];

  if (input.create_capture_event === true) {
    originEventId = originEventId ?? createId();
    await writeEvent(db, {
      id: originEventId,
      session_id: null,
      actor_kind: input.source === 'agent' ? 'agent' : 'user',
      actor_ref: input.source === 'agent' ? 'records' : 'self',
      action: 'experimental:record_capture',
      subject_kind: 'record',
      subject_id: id,
      outcome: 'success',
      payload: {
        record_kind: input.kind,
        activity_kind: input.activity_kind,
        capture_mode: input.capture_mode,
        summary_md: input.content_md.slice(0, 500),
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
    origin_event = { id: originEventId, action: 'experimental:record_capture' };
  }

  const [record] = await db
    .insert(learning_record)
    .values({
      id,
      kind: input.kind,
      title: input.title ?? null,
      content_md: input.content_md,
      source: input.source,
      capture_mode: input.capture_mode,
      activity_kind: input.activity_kind,
      processing_status: input.processing_status ?? 'raw',
      origin_event_id: originEventId,
      subject_id: input.subject_id ?? null,
      knowledge_ids: input.knowledge_ids,
      question_id: input.question_id ?? null,
      attempt_event_id: input.attempt_event_id ?? null,
      learning_item_id: input.learning_item_id ?? null,
      artifact_id: input.artifact_id ?? null,
      source_document_id: input.source_document_id ?? null,
      asset_refs: input.asset_refs ?? [],
      payload: input.payload,
      created_at: now,
      updated_at: now,
      archived_at: null,
      version: 0,
    })
    .returning();

  return { record, origin_event };
}

export async function listLearningRecords(
  db: DbLike,
  filter: ListLearningRecordsFilter = {},
): Promise<LearningRecordListRow[]> {
  const conditions: SQL[] = [];
  if (!filter.include_archived) conditions.push(isNull(learning_record.archived_at));
  if (filter.kind && filter.kind.length > 0)
    conditions.push(inArray(learning_record.kind, filter.kind));
  if (filter.question_id) conditions.push(eq(learning_record.question_id, filter.question_id));
  if (filter.attempt_event_id) {
    conditions.push(eq(learning_record.attempt_event_id, filter.attempt_event_id));
  }
  if (filter.knowledge_id) {
    conditions.push(
      sql`${learning_record.knowledge_ids} @> ${JSON.stringify([filter.knowledge_id])}::jsonb`,
    );
  }
  if (filter.activity_kind)
    conditions.push(eq(learning_record.activity_kind, filter.activity_kind));
  if (filter.processing_status && filter.processing_status.length > 0) {
    conditions.push(inArray(learning_record.processing_status, filter.processing_status));
  }
  if (filter.since) conditions.push(gte(learning_record.created_at, filter.since));

  const base = db.select().from(learning_record);
  const query =
    conditions.length > 0
      ? base.where(and(...conditions)).orderBy(desc(learning_record.created_at))
      : base.orderBy(desc(learning_record.created_at));
  return await query.limit(filter.limit ?? 50);
}

export async function getLearningRecord(db: DbLike, id: string): Promise<LearningRecordRow | null> {
  const rows = await db.select().from(learning_record).where(eq(learning_record.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateLearningRecord(
  db: DbLike,
  id: string,
  patch: UpdateLearningRecordPatch,
): Promise<LearningRecordRow> {
  if (patch.knowledge_ids) await assertKnowledgeIdsActive(db, patch.knowledge_ids);
  const now = new Date();
  const rows = await db
    .update(learning_record)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content_md !== undefined ? { content_md: patch.content_md } : {}),
      ...(patch.knowledge_ids !== undefined ? { knowledge_ids: patch.knowledge_ids } : {}),
      ...(patch.processing_status !== undefined
        ? { processing_status: patch.processing_status }
        : {}),
      ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
      updated_at: now,
      version: patch.version + 1,
    })
    .where(and(eq(learning_record.id, id), eq(learning_record.version, patch.version)))
    .returning();
  if (rows.length === 0) {
    throw new ApiError('conflict', `learning_record ${id} version mismatch`, 409);
  }
  return rows[0];
}

export async function archiveLearningRecord(db: DbLike, id: string): Promise<void> {
  const current = await getLearningRecord(db, id);
  if (!current) throw new ApiError('not_found', `learning_record ${id} not found`, 404);
  const now = new Date();
  const rows = await db
    .update(learning_record)
    .set({
      processing_status: 'archived',
      archived_at: now,
      updated_at: now,
      version: current.version + 1,
    })
    .where(and(eq(learning_record.id, id), eq(learning_record.version, current.version)))
    .returning({ id: learning_record.id });
  if (rows.length === 0) {
    throw new ApiError('conflict', `learning_record ${id} version mismatch`, 409);
  }
}
