// Tombstone appliers for record_links and record_promotion, which belong to the
// retired learning_record domain. They exist only to accept historical proposals;
// no live producer emits these kinds, and composition subtracts them as tombstones.

import { and, eq, isNull } from 'drizzle-orm';
import { newId } from '@/core/ids';
import {
  LEGACY_DRAFT_STATUS,
  MARKING_RULE_PROVENANCE,
  QUESTION_AVAILABILITY,
  SCORING_ADMISSION_STATE,
} from '@/core/schema/assessment/lifecycle';
import { ArtifactBodyBlocks, type ArtifactBodyBlocksT } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, knowledge, learning_item, learning_record, question } from '@/db/schema';
import { artifactRowToCreateSnapshot, emitArtifactCreateEvent } from '@/kernel/artifacts';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { lockPlacementSupplyScopes } from '@/kernel/placement';
import {
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  requiredString,
} from '@/kernel/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/kernel/proposals/signals';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { createPendingLearningItem } from '@/kernel/records/learning-items';
import { updateLearningRecord } from '@/kernel/records/queries';

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
    await updateLearningRecord(tx, recordId, {
      processing_status: 'actioned',
      knowledge_ids: knowledgeIds,
      question_id: questionId,
      learning_item_id: learningItemId,
      artifact_id: artifactId,
      payload,
      version: record.version,
    });
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

// Validate body_blocks at the artifact insert instead of casting. The draft is a
// free-form payload, so an untyped pass-through could store a malformed document
// that fails only later. A present value must satisfy ArtifactBodyBlocks; an absent
// one keeps the NULL default. Only used for target='artifact'.
function draftBodyBlocks(
  draft: Record<string, unknown>,
  proposalId: string,
): ArtifactBodyBlocksT | undefined {
  if (draft.body_blocks === undefined) return undefined;
  const parsed = ArtifactBodyBlocks.safeParse(draft.body_blocks);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      `record_promotion proposal ${proposalId} has invalid draft.body_blocks: ${parsed.error.message}`,
      400,
    );
  }
  return parsed.data;
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
      await lockPlacementSupplyScopes(tx, knowledgeIds);
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
          draft_status: LEGACY_DRAFT_STATUS.ACTIVE,
          created_by: {
            by: 'ai',
            task_kind: 'record_promotion',
            propose_event_id: proposalId,
          } as never,
          created_at: now,
          updated_at: now,
        }),
      );

      // Every reachable accept path must mint the new contract. Dreaming content is
      // AI-proposed but user-accepted, so it carries manual provenance; the accept is
      // the human verification gate.
      await publishQuestionGroupFromRow(tx, {
        rootId: materializedId,
        admission: {
          state: SCORING_ADMISSION_STATE.ADMITTED,
          evidence: {
            marking_provenance: MARKING_RULE_PROVENANCE.MANUAL,
            verification: {
              structural_check_passed: true,
              independent_verification: {
                passed: true,
                verifier: 'human',
                verified_at: now.toISOString(),
              },
            },
            model_slice: null,
          },
        },
        availability: QUESTION_AVAILABILITY.GENERAL_POOL,
        actorRef: 'legacy-record-accept:question',
        now,
      });
    } else if (target === 'learning_item') {
      await createPendingLearningItem(
        tx,
        {
          id: materializedId,
          source: 'ai_dream',
          source_ref: proposalId,
          title,
          content,
          knowledge_ids: knowledgeIds,
          primary_artifact_id: null,
          parent_learning_item_id: null,
        },
        now,
      );
    } else {
      // Insert and return the full row, then emit artifact_create in the same tx from
      // the materialized row so every strict snapshot column has a real value. The
      // body_blocks schema check runs at this seam; undefined keeps the NULL default.
      const bodyBlocks = draftBodyBlocks(draft, proposalId);
      const [insertedArtifact] = await tx
        .insert(artifact)
        .values({
          id: materializedId,
          type: 'note_long',
          title,
          knowledge_ids: knowledgeIds,
          intent_source: 'from_dream',
          source: 'ai_dream',
          source_ref: proposalId,
          generation_status: 'ready',
          ...(bodyBlocks !== undefined ? { body_blocks: bodyBlocks } : {}),
          created_at: now,
          updated_at: now,
        })
        .returning();
      await emitArtifactCreateEvent(tx, {
        row: artifactRowToCreateSnapshot(insertedArtifact),
        actorKind: 'agent',
        actorRef: 'record_promotion',
        causedByEventId: rateEventId,
        createdAt: now,
      });
    }

    await updateLearningRecord(tx, recordId, {
      processing_status: 'actioned',
      question_id: target === 'question' ? materializedId : record.question_id,
      learning_item_id: target === 'learning_item' ? materializedId : record.learning_item_id,
      artifact_id: target === 'artifact' ? materializedId : record.artifact_id,
      payload,
      version: record.version,
    });

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
