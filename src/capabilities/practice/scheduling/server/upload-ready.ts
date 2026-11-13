// Upload delivery owns batch membership, current eligibility and durable daily delivery.
// Receipts remember delivery identity; serving and purpose remain canonical live reads.
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { UploadPracticeDeliveryPayload } from '@/core/schema/event';
import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import {
  event,
  event_subscription_checkpoint,
  learning_session,
  practice_stream_item,
  question,
  question_block,
  question_group_lifecycle,
  source_document,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { lockPracticeStreamPartition } from '@/kernel/locks/practice-stream';
import type { EventSubscriptionHandler } from '@/kernel/manifest';
import {
  type PurposeSource,
  readSourceUsageEpochs,
  sourceAllowsDerivation,
} from '@/kernel/read-models/usage-policy';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';
import { streamLocalDate } from '@/kernel/stream-date';

export const UPLOAD_READY_SUBSCRIBER = 'practice.upload-ready';
export const UPLOAD_READY_ACTIONS = [
  'experimental:assessment_publish',
  'experimental:question_block_lifecycle',
];
const DELIVERY_ACTION = 'experimental:upload_practice_delivery';
const ACTIVE_BLOCK_STATUSES = ['auto_enrolled', 'imported', 'submitted'];

export function isUploadPracticeRow(row: { signals?: Record<string, unknown> }): boolean {
  const marker = row.signals?.upload_practice as Record<string, unknown> | undefined;
  return marker?.version === 1 && typeof marker.batch_id === 'string';
}

export const ordinaryStreamRowPredicate = sql`NOT (
  coalesce(${practice_stream_item.signals}->'upload_practice'->>'version', '') = '1'
  AND coalesce(jsonb_typeof(${practice_stream_item.signals}->'upload_practice'->'batch_id'), '') = 'string'
)`;

export interface UploadReadyBatch {
  sessionId: string;
  sourceDocumentId: string | null;
  ready: Array<{
    questionId: string;
    revisionId: string;
    admissionGeneration: number;
    ordinal: number;
  }>;
  waitingCount: number;
  withheldCount: number;
}

async function batchMembers(db: Db | Tx, sessionId: string) {
  return db
    .select({
      block: question_block,
      rootId: sql<string>`coalesce(${question.parent_question_id}, ${question.id})`,
    })
    .from(question_block)
    .innerJoin(question, eq(question.id, question_block.imported_question_id))
    .where(
      and(
        eq(question_block.ingestion_session_id, sessionId),
        inArray(question_block.status, ACTIVE_BLOCK_STATUSES),
      ),
    )
    .orderBy(asc(question_block.ordinal), asc(question_block.id));
}

/** Current complete roots, never extraction counts or a stored ready flag. */
export async function readUploadReadyBatch(
  db: Db | Tx,
  sessionId: string,
): Promise<UploadReadyBatch | null> {
  const [session] = await db
    .select()
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')));
  if (!session) return null;
  const members = await batchMembers(db, sessionId);
  const rootIds = [...new Set(members.map((m) => m.rootId))];
  const batch: UploadReadyBatch = {
    sessionId,
    sourceDocumentId: session.source_document_id,
    ready: [],
    waitingCount: 0,
    withheldCount: 0,
  };
  if (!rootIds.length) return batch;
  const servable = await readAutomaticallyServableQuestionIds(db, rootIds);
  const heads = await db
    .select()
    .from(question_group_lifecycle)
    .where(inArray(question_group_lifecycle.group_id, rootIds));
  const sessionAllowed = await sourceAllowsDerivation(db, { kind: 'session', id: sessionId });
  for (const rootId of rootIds) {
    const bound = members.filter((m) => m.rootId === rootId);
    let allowed = sessionAllowed;
    for (const member of bound) {
      if (
        member.block.imported_question_id &&
        !(await sourceAllowsDerivation(db, {
          kind: 'question',
          id: member.block.imported_question_id,
        }))
      )
        allowed = false;
      if (
        member.block.source_document_id &&
        !(await sourceAllowsDerivation(db, {
          kind: 'document',
          id: member.block.source_document_id,
        }))
      )
        allowed = false;
    }
    const head = heads.find((h) => h.group_id === rootId);
    if (!allowed) batch.withheldCount++;
    else if (!servable.has(rootId) || !head?.current_revision_id) batch.waitingCount++;
    else
      batch.ready.push({
        questionId: rootId,
        revisionId: head.current_revision_id,
        admissionGeneration: head.scoring_admission_generation,
        ordinal: bound[0].block.ordinal,
      });
  }
  return batch;
}

function deliveryId(sessionId: string, rootId: string): string {
  return `upload-practice:${createHash('sha256')
    .update(JSON.stringify([sessionId, rootId]))
    .digest('hex')}`;
}

async function reconcileBatch(db: Db, sessionId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    await tx
      .select({ id: question_block.id })
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId))
      .orderBy(asc(question_block.id))
      .for('share');
    const members = await batchMembers(tx, sessionId);
    const rootIds = [...new Set(members.map((m) => m.rootId))].sort();
    if (!rootIds.length) return 0;
    await tx
      .select({ id: question.id })
      .from(question)
      .where(inArray(question.id, rootIds))
      .orderBy(asc(question.id))
      .for('share');
    await tx
      .select({ id: question_group_lifecycle.group_id })
      .from(question_group_lifecycle)
      .where(inArray(question_group_lifecycle.group_id, rootIds))
      .orderBy(asc(question_group_lifecycle.group_id))
      .for('share');

    // Discover the whole provenance closure before taking any document or partition lock.
    // writeEvent's session binding only reacquires a member of this same sorted set.
    const sources: PurposeSource[] = [
      { kind: 'session', id: sessionId },
      ...rootIds.map((id) => ({ kind: 'question' as const, id })),
    ];
    for (const member of members) {
      if (member.block.source_document_id)
        sources.push({ kind: 'document', id: member.block.source_document_id });
      if (member.block.imported_question_id)
        sources.push({ kind: 'question', id: member.block.imported_question_id });
    }
    const documentIds = new Set<string>();
    for (const source of sources)
      for (const id of Object.keys(await readSourceUsageEpochs(tx, source))) documentIds.add(id);
    if (documentIds.size)
      await tx
        .select({ id: source_document.id })
        .from(source_document)
        .where(inArray(source_document.id, [...documentIds]))
        .orderBy(asc(source_document.id))
        .for('share');
    const batch = await readUploadReadyBatch(tx, sessionId);
    if (!batch) return 0;
    const date = streamLocalDate();
    await lockPracticeStreamPartition(tx, date);
    let added = 0;
    for (const ready of batch.ready) {
      const id = deliveryId(sessionId, ready.questionId);
      const [prior] = await tx.select().from(event).where(eq(event.id, id));
      if (prior) {
        const receipt = UploadPracticeDeliveryPayload.parse(prior.payload);
        const [row] = await tx
          .select({ id: practice_stream_item.id })
          .from(practice_stream_item)
          .where(eq(practice_stream_item.id, receipt.row_id));
        if (!row)
          console.error('[upload-ready] delivered row missing; preserving receipt', {
            receiptId: id,
            rowId: receipt.row_id,
          });
        continue;
      }
      const [existing] = await tx
        .select()
        .from(practice_stream_item)
        .where(
          and(
            eq(practice_stream_item.date, date),
            isNull(practice_stream_item.session_id),
            eq(practice_stream_item.ref_id, ready.questionId),
          ),
        );
      const marker = { version: 1, batch_id: sessionId };
      let rowId = existing?.id;
      if (existing?.status === 'pending') {
        await tx
          .update(practice_stream_item)
          .set({ signals: { ...existing.signals, upload_practice: marker } })
          .where(eq(practice_stream_item.id, existing.id));
      } else if (!existing) {
        rowId = `${id}:row`;
        const [tail] = await tx
          .select({
            position: sql<number>`coalesce(max(${practice_stream_item.position}), 0)::int`,
          })
          .from(practice_stream_item)
          .where(and(eq(practice_stream_item.date, date), isNull(practice_stream_item.session_id)));
        await tx.insert(practice_stream_item).values({
          id: rowId,
          date,
          position: tail.position + 1,
          item_kind: 'question',
          ref_id: ready.questionId,
          source: 'import',
          status: 'pending',
          reasoning: '刚上传',
          added_by: 'user',
          signals: { upload_practice: marker },
        });
        added++;
      }
      await writeEvent(tx, {
        id,
        session_id: sessionId,
        actor_kind: 'system',
        actor_ref: 'upload-practice',
        action: DELIVERY_ACTION,
        subject_kind: 'question',
        subject_id: ready.questionId,
        payload: {
          version: 1,
          batch_id: sessionId,
          root_id: ready.questionId,
          date,
          row_id: rowId,
          disposition: existing ? 'already_present' : 'inserted',
          revision_id: ready.revisionId,
          admission_generation: ready.admissionGeneration,
        },
        affected_scopes: [],
        ingest_at: new Date(),
      });
      const [committed] = await tx.select().from(event).where(eq(event.id, id));
      if (!committed || UploadPracticeDeliveryPayload.parse(committed.payload).row_id !== rowId)
        throw new Error('upload delivery identity conflict');
    }
    return added;
  });
}

/** Fixed subscriber activation day covers bootstrap-skipped publications and later retries. */
export async function reconcileTodayUploadPractice(db: Db): Promise<number> {
  const [checkpoint] = await db
    .select({ activatedAt: event_subscription_checkpoint.activated_at })
    .from(event_subscription_checkpoint)
    .where(
      and(
        eq(event_subscription_checkpoint.subscriber_id, UPLOAD_READY_SUBSCRIBER),
        eq(event_subscription_checkpoint.subscriber_version, 1),
      ),
    );
  if (!checkpoint?.activatedAt) return 0;
  const lower = new Date(`${streamLocalDate(checkpoint.activatedAt)}T00:00:00+08:00`).toISOString();
  let cursor = '',
    added = 0;
  for (;;) {
    const batches = await db.execute<{ id: string }>(sql`
      SELECT DISTINCT b.ingestion_session_id AS id FROM question_block b
      JOIN learning_session s ON s.id = b.ingestion_session_id AND s.type = 'ingestion'
      JOIN question q ON q.id = b.imported_question_id
      WHERE b.ingestion_session_id > ${cursor} AND b.status IN ('auto_enrolled','imported','submitted')
        AND (b.created_at >= ${lower} OR s.created_at >= ${lower} OR EXISTS (
          SELECT 1 FROM event e WHERE e.created_at >= ${lower} AND (
            (e.action = 'experimental:assessment_publish' AND e.subject_kind = 'question' AND e.subject_id = coalesce(q.parent_question_id,q.id))
            OR (e.action = 'experimental:question_block_lifecycle' AND e.subject_kind = 'question_block' AND e.subject_id = b.id))))
      ORDER BY id LIMIT 100`);
    if (!batches.length) return added;
    for (const batch of batches) added += await reconcileBatch(db, batch.id);
    cursor = batches[batches.length - 1].id;
  }
}

export function buildUploadReadySubscriber(db: Db): EventSubscriptionHandler {
  return async () => {
    const added = await reconcileTodayUploadPractice(db);
    return { status: 'succeeded', detail: { added } };
  };
}
