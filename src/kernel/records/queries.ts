import { createId } from '@paralleldrive/cuid2';
import { type SQL, and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { knowledge, learning_record } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import type {
  CreateLearningRecordInput,
  CreateLearningRecordResult,
  LearningRecordListRow,
  LearningRecordProcessingStatus,
  LearningRecordRow,
  ListLearningRecordsFilter,
  TransitionLearningRecordInput,
  TransitionLearningRecordResult,
  UpdateLearningRecordPatch,
} from './types';

type DbLike = Db | Tx;

class StaleLearningRecordMutationError extends ApiError {}

const BATCH_TRANSITION_MAX_ATTEMPTS = 2;

const LEARNING_RECORD_STATUS_TRANSITIONS: Readonly<
  Record<LearningRecordProcessingStatus, readonly LearningRecordProcessingStatus[]>
> = {
  raw: ['linked', 'actioned', 'archived'],
  linked: ['actioned', 'archived'],
  // Retraction is the one deliberate backward edge: accepted proposal evidence remains linked.
  actioned: ['linked', 'archived'],
  archived: [],
};

function asProcessingStatus(value: string, recordId: string): LearningRecordProcessingStatus {
  if (value === 'raw' || value === 'linked' || value === 'actioned' || value === 'archived') {
    return value;
  }
  console.warn('[learning-record] mutation_rejected', {
    reason: 'illegal_current_status',
    record_id: recordId,
    current_status: value,
  });
  throw new ApiError(
    'conflict',
    `learning_record ${recordId} has unknown processing_status '${value}'`,
    409,
  );
}

function rejectStaleMutation(
  recordId: string,
  expectedVersion: number,
  currentVersion: number | null,
): never {
  console.warn('[learning-record] mutation_rejected', {
    reason: 'stale_version',
    record_id: recordId,
    expected_version: expectedVersion,
    current_version: currentVersion,
  });
  throw new StaleLearningRecordMutationError(
    'conflict',
    `learning_record ${recordId} version mismatch`,
    409,
  );
}

function assertLegalStatusTransition(
  recordId: string,
  from: LearningRecordProcessingStatus,
  to: LearningRecordProcessingStatus,
): void {
  if (from === to || LEARNING_RECORD_STATUS_TRANSITIONS[from].includes(to)) return;
  console.warn('[learning-record] mutation_rejected', {
    reason: 'illegal_status_transition',
    record_id: recordId,
    from_status: from,
    to_status: to,
  });
  throw new ApiError(
    'conflict',
    `learning_record ${recordId} cannot transition ${from} -> ${to}`,
    409,
  );
}

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
      archived_at: input.processing_status === 'archived' ? now : null,
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
  if (filter.before_created_at && filter.before_id) {
    const cursorFilter = or(
      lt(learning_record.created_at, filter.before_created_at),
      and(
        eq(learning_record.created_at, filter.before_created_at),
        lt(learning_record.id, filter.before_id),
      ),
    );
    if (cursorFilter) conditions.push(cursorFilter);
  }

  const base = db.select().from(learning_record);
  const query =
    conditions.length > 0
      ? base
          .where(and(...conditions))
          .orderBy(desc(learning_record.created_at), desc(learning_record.id))
      : base.orderBy(desc(learning_record.created_at), desc(learning_record.id));
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
  const current = await getLearningRecord(db, id);
  if (!current) throw new ApiError('not_found', `learning_record ${id} not found`, 404);
  const currentStatus = asProcessingStatus(current.processing_status, id);
  if (current.version !== patch.version) {
    rejectStaleMutation(id, patch.version, current.version);
  }
  if (currentStatus === 'archived') {
    assertLegalStatusTransition(id, currentStatus, patch.processing_status ?? currentStatus);
    console.warn('[learning-record] mutation_rejected', {
      reason: 'archived_record_is_terminal',
      record_id: id,
      current_version: current.version,
    });
    throw new ApiError('conflict', `learning_record ${id} is archived and immutable`, 409);
  }
  const targetStatus = patch.processing_status ?? currentStatus;
  assertLegalStatusTransition(id, currentStatus, targetStatus);
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
      ...(patch.question_id !== undefined ? { question_id: patch.question_id } : {}),
      ...(patch.learning_item_id !== undefined ? { learning_item_id: patch.learning_item_id } : {}),
      ...(patch.artifact_id !== undefined ? { artifact_id: patch.artifact_id } : {}),
      ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
      ...(targetStatus === 'archived' ? { archived_at: now } : {}),
      updated_at: now,
      version: patch.version + 1,
    })
    .where(
      and(
        eq(learning_record.id, id),
        eq(learning_record.version, patch.version),
        eq(learning_record.processing_status, currentStatus),
      ),
    )
    .returning();
  if (rows.length === 0) {
    const latest = await getLearningRecord(db, id);
    rejectStaleMutation(id, patch.version, latest?.version ?? null);
  }
  return rows[0];
}

export async function transitionLearningRecord(
  db: DbLike,
  id: string,
  input: TransitionLearningRecordInput,
): Promise<TransitionLearningRecordResult> {
  const current = await getLearningRecord(db, id);
  if (!current) throw new ApiError('not_found', `learning_record ${id} not found`, 404);
  const currentStatus = asProcessingStatus(current.processing_status, id);
  if (current.version !== input.expected_version) {
    if (currentStatus === input.to) return { record: current, applied: false };
    rejectStaleMutation(id, input.expected_version, current.version);
  }
  if (currentStatus === input.to) return { record: current, applied: false };
  assertLegalStatusTransition(id, currentStatus, input.to);

  const now = new Date();
  const rows = await db
    .update(learning_record)
    .set({
      processing_status: input.to,
      ...(input.to === 'archived' ? { archived_at: now } : {}),
      updated_at: now,
      version: current.version + 1,
    })
    .where(
      and(
        eq(learning_record.id, id),
        eq(learning_record.version, input.expected_version),
        eq(learning_record.processing_status, currentStatus),
      ),
    )
    .returning();
  if (rows.length === 0) {
    const latest = await getLearningRecord(db, id);
    if (latest && asProcessingStatus(latest.processing_status, id) === input.to) {
      return { record: latest, applied: false };
    }
    rejectStaleMutation(id, input.expected_version, latest?.version ?? null);
  }
  return { record: rows[0], applied: true };
}

export async function transitionLearningRecords(
  db: DbLike,
  ids: readonly string[],
  fromStatuses: readonly LearningRecordProcessingStatus[],
  to: LearningRecordProcessingStatus,
): Promise<number> {
  if (ids.length === 0) return 0;
  const uniqueIds = [...new Set(ids)].sort();
  const rows = await db
    .select()
    .from(learning_record)
    .where(inArray(learning_record.id, uniqueIds));
  rows.sort((a, b) => a.id.localeCompare(b.id));

  let applied = 0;
  for (const row of rows) {
    let candidate = row;
    for (let attempt = 0; attempt < BATCH_TRANSITION_MAX_ATTEMPTS; attempt += 1) {
      const status = asProcessingStatus(candidate.processing_status, candidate.id);
      if (status === to || !fromStatuses.includes(status)) break;
      try {
        const result = await transitionLearningRecord(db, candidate.id, {
          expected_version: candidate.version,
          to,
        });
        if (result.applied) applied += 1;
        break;
      } catch (error) {
        if (!(error instanceof StaleLearningRecordMutationError)) throw error;
        const latest = await getLearningRecord(db, candidate.id);
        if (!latest) break;
        const latestStatus = asProcessingStatus(latest.processing_status, latest.id);
        if (latestStatus === to || !fromStatuses.includes(latestStatus)) break;
        candidate = latest;
        if (attempt === BATCH_TRANSITION_MAX_ATTEMPTS - 1) {
          console.warn('[learning-record] batch_transition_retry_exhausted', {
            record_id: candidate.id,
            current_version: candidate.version,
            current_status: latestStatus,
            target_status: to,
          });
        }
      }
    }
  }
  return applied;
}

export async function archiveLearningRecord(
  db: DbLike,
  id: string,
  expectedVersion: number,
): Promise<void> {
  await transitionLearningRecord(db, id, {
    expected_version: expectedVersion,
    to: 'archived',
  });
}

/**
 * YUK-892 — active (non-archived) learning-record lookup shared by the
 * capability-owned record proposal tools (Practice author-question record seed +
 * Ingestion record links/promotion).
 */
export async function getActiveLearningRecord(
  db: DbLike,
  recordId: string,
): Promise<LearningRecordRow | null> {
  const row = (
    await db
      .select()
      .from(learning_record)
      .where(and(eq(learning_record.id, recordId), isNull(learning_record.archived_at)))
      .limit(1)
  )[0];
  return row ?? null;
}
