// M4-T4 (YUK-319) — D11 墓碑：record_links / record_promotion 两 kind 属旧学习
// 记录（learning_record）域，D11 裁定该域不迁包；appliers 从 dispatch 壳
// （actions.ts @ src/server/proposals）等价平移至此兜历史数据（搬迁不改逻辑）。
// 无活 producer；composition 对账以 LEGACY_TOMBSTONE_KINDS 从期望全集减除
// （src/capabilities/composition.unit.test.ts），不要求任何包声明归属。

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { artifact, knowledge, learning_item, learning_record, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
// YUK-471 W2 — learning_item projection seam (ai_dream record_promotion). The INSERT writes a per-id
// genesis BASE event + index anchor regardless of the flag; projectionIsWriter('learning_item') gates
// ONLY who writes the ROW (projection write-through when ON, imperative INSERT when OFF + parity assert).
import { projectLearningItem } from '@/server/projections/learning_item';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
import {
  assertLearningItemParity,
  learningItemLiveRowToSnapshot,
} from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';
import { withAnswerClass } from '@/server/questions/answer-class-write';
import { and, eq, isNull } from 'drizzle-orm';
import {
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  requiredString,
} from './applier-helpers';
import type { ProposalInboxRow } from './inbox';
import { ensureProposalDecisionSignal, recordProposalDecisionSignal } from './signals';

// 结构最小化（与 practice / agency / ingestion 包同模式）：只声明本文件 applier
// 实际读取的字段；壳层 AcceptAiProposalOpts 结构可赋值，调用点无需收窄。
export interface LegacyRecordApplierOpts {
  decision?: string;
  user_note?: string;
}

export interface RecordLinksAcceptResult {
  kind: 'record_links';
  rate_event_id: string;
  record_id: string;
  applied_links: number;
  idempotent?: boolean;
}

export interface RecordPromotionAcceptResult {
  kind: 'record_promotion';
  rate_event_id: string;
  record_id: string;
  materialized_kind: 'question' | 'learning_item' | 'artifact';
  materialized_id: string;
  idempotent?: boolean;
}

type RecordLinkTargetKind = 'knowledge' | 'question' | 'learning_item' | 'artifact';
type RecordPromotionTarget = 'question' | 'learning_item' | 'artifact';

interface RecordLinkInput {
  target_kind: RecordLinkTargetKind;
  target_id: string;
  relation?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
}

function parseRecordLinks(change: Record<string, unknown>, proposalId: string): RecordLinkInput[] {
  if (!Array.isArray(change.links) || change.links.length === 0) {
    throw new ApiError(
      'validation_error',
      `record_links proposal ${proposalId} is missing links`,
      400,
    );
  }
  return change.links.map((raw, index) => {
    const link = asPlainRecord(raw);
    const targetKind = link.target_kind;
    if (
      targetKind !== 'knowledge' &&
      targetKind !== 'question' &&
      targetKind !== 'learning_item' &&
      targetKind !== 'artifact'
    ) {
      throw new ApiError(
        'validation_error',
        `record_links proposal ${proposalId} has invalid links[${index}].target_kind`,
        400,
      );
    }
    return {
      target_kind: targetKind,
      target_id: requiredString(link.target_id, `links[${index}].target_id`, proposalId),
      relation: link.relation,
      confidence: link.confidence,
      reasoning: link.reasoning,
    };
  });
}

async function assertTargetExists(
  db: Db,
  targetKind: RecordLinkTargetKind,
  targetId: string,
): Promise<void> {
  let exists = false;
  switch (targetKind) {
    case 'knowledge':
      exists = Boolean(
        (
          await db
            .select({ id: knowledge.id })
            .from(knowledge)
            .where(and(eq(knowledge.id, targetId), isNull(knowledge.archived_at)))
            .limit(1)
        )[0],
      );
      break;
    case 'question':
      exists = Boolean(
        (
          await db
            .select({ id: question.id })
            .from(question)
            .where(eq(question.id, targetId))
            .limit(1)
        )[0],
      );
      break;
    case 'learning_item':
      exists = Boolean(
        (
          await db
            .select({ id: learning_item.id })
            .from(learning_item)
            .where(and(eq(learning_item.id, targetId), isNull(learning_item.archived_at)))
            .limit(1)
        )[0],
      );
      break;
    case 'artifact':
      exists = Boolean(
        (
          await db
            .select({ id: artifact.id })
            .from(artifact)
            .where(and(eq(artifact.id, targetId), isNull(artifact.archived_at)))
            .limit(1)
        )[0],
      );
      break;
  }
  if (!exists) {
    throw new ApiError('not_found', `${targetKind} target ${targetId} not found`, 404);
  }
}

export async function acceptRecordLinksProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: LegacyRecordApplierOpts,
): Promise<RecordLinksAcceptResult> {
  ensureAcceptOnly('record_links', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const recordId = requiredString(change.record_id, 'record_id', proposalId);
  const links = parseRecordLinks(change, proposalId);

  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    return {
      kind: 'record_links',
      rate_event_id: existingRate.id,
      record_id: recordId,
      applied_links: links.length,
      idempotent: true,
    };
  }

  const record = (
    await db
      .select()
      .from(learning_record)
      .where(and(eq(learning_record.id, recordId), isNull(learning_record.archived_at)))
      .limit(1)
  )[0];
  if (!record) throw new ApiError('not_found', `record ${recordId} not found`, 404);
  for (const link of links) {
    await assertTargetExists(db, link.target_kind, link.target_id);
  }

  const now = new Date();
  const rateEventId = newId();
  const knowledgeIds = [
    ...new Set([
      ...record.knowledge_ids,
      ...links.filter((link) => link.target_kind === 'knowledge').map((link) => link.target_id),
    ]),
  ];
  const questionId =
    record.question_id ?? links.find((link) => link.target_kind === 'question')?.target_id ?? null;
  const learningItemId =
    record.learning_item_id ??
    links.find((link) => link.target_kind === 'learning_item')?.target_id ??
    null;
  const artifactId =
    record.artifact_id ?? links.find((link) => link.target_kind === 'artifact')?.target_id ?? null;
  const payload = {
    ...asPlainRecord(record.payload),
    accepted_record_links: [
      ...(Array.isArray(asPlainRecord(record.payload).accepted_record_links)
        ? (asPlainRecord(record.payload).accepted_record_links as unknown[])
        : []),
      ...links.map((link) => ({ ...link, proposal_id: proposalId })),
    ],
  };

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(learning_record)
      .set({
        processing_status: 'actioned',
        knowledge_ids: knowledgeIds,
        question_id: questionId,
        learning_item_id: learningItemId,
        artifact_id: artifactId,
        payload,
        updated_at: now,
        version: record.version + 1,
      })
      .where(and(eq(learning_record.id, recordId), eq(learning_record.version, record.version)))
      .returning({ id: learning_record.id });
    if (updated.length !== 1) {
      throw new ApiError('conflict', `record ${recordId} concurrently modified`, 409);
    }
    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        record_id: recordId,
        applied_links: links,
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return {
    kind: 'record_links',
    rate_event_id: rateEventId,
    record_id: recordId,
    applied_links: links.length,
  };
}

function parseRecordPromotionTarget(value: unknown, proposalId: string): RecordPromotionTarget {
  if (value === 'question' || value === 'learning_item' || value === 'artifact') return value;
  throw new ApiError(
    'validation_error',
    `record_promotion proposal ${proposalId} has invalid target`,
    400,
  );
}

function draftString(draft: Record<string, unknown>, key: string, fallback: string): string {
  const value = draft[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function draftKnowledgeIds(draft: Record<string, unknown>, fallback: string[]): string[] {
  const value = draft.knowledge_ids;
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...new Set(value)]
    : fallback;
}

export async function acceptRecordPromotionProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: LegacyRecordApplierOpts,
): Promise<RecordPromotionAcceptResult> {
  ensureAcceptOnly('record_promotion', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const recordId = requiredString(change.record_id, 'record_id', proposalId);
  const target = parseRecordPromotionTarget(change.target, proposalId);
  const draft = asPlainRecord(change.draft);

  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    return {
      kind: 'record_promotion',
      rate_event_id: existingRate.id,
      record_id: recordId,
      materialized_kind: target,
      materialized_id: String(
        (existingRate.payload as { materialized_id?: unknown }).materialized_id ?? '',
      ),
      idempotent: true,
    };
  }

  const record = (
    await db
      .select()
      .from(learning_record)
      .where(and(eq(learning_record.id, recordId), isNull(learning_record.archived_at)))
      .limit(1)
  )[0];
  if (!record) throw new ApiError('not_found', `record ${recordId} not found`, 404);

  const now = new Date();
  const rateEventId = newId();
  const materializedId = newId();
  const knowledgeIds = draftKnowledgeIds(draft, record.knowledge_ids);
  const title = draftString(draft, 'title', record.title ?? record.content_md.slice(0, 80));
  const content = draftString(
    draft,
    'content',
    draftString(draft, 'content_md', record.content_md),
  );
  const payload = {
    ...asPlainRecord(record.payload),
    accepted_record_promotion: {
      proposal_id: proposalId,
      target,
      materialized_id: materializedId,
    },
  };

  await db.transaction(async (tx) => {
    if (target === 'question') {
      await tx.insert(question).values(
        withAnswerClass({
          id: materializedId,
          kind: 'short_answer',
          prompt_md: draftString(draft, 'prompt_md', content),
          reference_md:
            typeof draft.reference_md === 'string' && draft.reference_md.length > 0
              ? draft.reference_md
              : null,
          knowledge_ids: knowledgeIds,
          difficulty: typeof draft.difficulty === 'number' ? draft.difficulty : 3,
          source: 'dreaming',
          source_ref: proposalId,
          draft_status: 'active',
          created_by: {
            by: 'ai',
            task_kind: 'record_promotion',
            propose_event_id: proposalId,
          } as never,
          created_at: now,
          updated_at: now,
        }),
      );
    } else if (target === 'learning_item') {
      // YUK-471 W2 — the full initial row snapshot is the genesis BASE state (learning_item has no
      // fold-blind field; per-id genesis fully seeds the row — design §3②/§3⑥). version defaults to
      // 0 at the column (the original INSERT did not set it), so the snapshot mirrors that.
      const liRow = {
        id: materializedId,
        source: 'ai_dream',
        source_ref: proposalId,
        title,
        content,
        knowledge_ids: knowledgeIds,
        primary_artifact_id: null,
        parent_learning_item_id: null,
        status: 'pending',
        user_pinned: false,
        completed_at: null,
        dismissed_at: null,
        archived_at: null,
        archived_reason: null,
        created_at: now,
        updated_at: now,
        version: 0,
      };
      // 1. ALWAYS write the per-id genesis BASE event FIRST (subject_id=materializedId) so the fold
      //    (when the flag is ON) sees it in the same tx. ingest_at=now → outbox opt-out.
      const genesisEventId = newId();
      await writeEvent(tx, {
        id: genesisEventId,
        actor_kind: 'system',
        actor_ref: 'genesis-backfill',
        action: 'experimental:genesis',
        subject_kind: 'learning_item',
        subject_id: materializedId,
        outcome: 'success',
        payload: { row: liRow },
        created_at: now,
        ingest_at: now,
      });
      // 2. ALWAYS write the materialized_id_index anchor (id → the genesis event) regardless of the flag.
      await upsertMaterializedIdIndex(tx, {
        materialized_id: materializedId,
        anchor_event_id: genesisEventId,
        subject_kind: 'learning_item',
      });
      // 3. ROW writer — gated on the per-entity flag (critic A1, defer-flip-not-build):
      //    ON → projectLearningItem folds the genesis + writes the row; OFF → the imperative INSERT
      //    stays the writer (current behavior) + a write-time fold==row parity assert.
      if (projectionIsWriter('learning_item')) {
        await projectLearningItem(tx, materializedId);
      } else {
        await tx.insert(learning_item).values({
          id: materializedId,
          source: 'ai_dream',
          source_ref: proposalId,
          title,
          content,
          knowledge_ids: knowledgeIds,
          status: 'pending',
          created_at: now,
          updated_at: now,
        });
        const [written] = await tx
          .select()
          .from(learning_item)
          .where(eq(learning_item.id, materializedId))
          .limit(1);
        await assertLearningItemParity(
          tx,
          materializedId,
          written ? learningItemLiveRowToSnapshot(written) : null,
        );
      }
    } else {
      await tx.insert(artifact).values({
        id: materializedId,
        type: 'note_long',
        title,
        knowledge_ids: knowledgeIds,
        intent_source: 'from_dream',
        source: 'ai_dream',
        source_ref: proposalId,
        generation_status: 'ready',
        ...(draft.body_blocks !== undefined ? { body_blocks: draft.body_blocks as never } : {}),
        created_at: now,
        updated_at: now,
      });
    }

    const updated = await tx
      .update(learning_record)
      .set({
        processing_status: 'actioned',
        question_id: target === 'question' ? materializedId : record.question_id,
        learning_item_id: target === 'learning_item' ? materializedId : record.learning_item_id,
        artifact_id: target === 'artifact' ? materializedId : record.artifact_id,
        payload,
        updated_at: now,
        version: record.version + 1,
      })
      .where(and(eq(learning_record.id, recordId), eq(learning_record.version, record.version)))
      .returning({ id: learning_record.id });
    if (updated.length !== 1) {
      throw new ApiError('conflict', `record ${recordId} concurrently modified`, 409);
    }

    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        record_id: recordId,
        materialized_kind: target,
        materialized_id: materializedId,
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return {
    kind: 'record_promotion',
    rate_event_id: rateEventId,
    record_id: recordId,
    materialized_kind: target,
    materialized_id: materializedId,
  };
}
