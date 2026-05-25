import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { ActivityRefT } from '@/core/schema/activity';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import {
  artifact,
  event,
  knowledge,
  knowledge_edge,
  learning_item,
  mistake_variant,
  question,
} from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import { acceptProposal, dismissProposal } from '@/server/knowledge/proposals';
import {
  type LearningIntentMaterializeResult,
  acceptLearningIntent,
} from '@/server/orchestrator/learning_intent';
// YUK-15 — record→proposal evidence loop: accept flips cited records to
// `actioned`, retract rolls them back to `linked`.
import {
  extractRecordEvidenceIds,
  markRecordsActioned,
  rollbackRecordsActioned,
} from '@/server/records/record_processing';
import { type ProposalInboxRow, getProposalInboxRow } from './inbox';
import { ensureProposalDecisionSignal, recordProposalDecisionSignal } from './signals';

// YUK-17 / ADR-0018 — swappable enqueue hook so DB tests can drive
// variant_question accept without spinning up pg-boss.
export type EnqueueVariantVerifyFn = (mistakeVariantId: string) => Promise<void>;

async function defaultEnqueueVariantVerify(mistakeVariantId: string): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('variant_verify', { mistake_variant_id: mistakeVariantId });
}

export type EdgeProposalDecision = 'accept' | 'reverse' | 'change_type' | 'dismiss';

export interface EdgeProposalDecisionInput {
  decision: EdgeProposalDecision;
  new_relation_type?: RelationTypeSchemaT;
  user_note?: string;
}

export interface KnowledgeEdgeProposalDecisionResult {
  kind: 'knowledge_edge';
  rate_event_id: string;
  generate_event_id: string | null;
  edge_id: string | null;
  idempotent?: boolean;
}

export type AcceptAiProposalResult =
  | {
      kind: 'knowledge_node';
      result: Awaited<ReturnType<typeof acceptProposal>>;
    }
  | KnowledgeEdgeProposalDecisionResult
  | VariantQuestionAcceptResult
  | LearningItemAcceptResult;

export interface VariantQuestionAcceptResult {
  kind: 'variant_question';
  rate_event_id: string;
  question_id: string;
  mistake_variant_id: string;
  idempotent?: boolean;
}

export interface LearningItemAcceptResult {
  kind: 'learning_item';
  /**
   * Rate event id chained to the proposal. For learning_item the rate event
   * is written by acceptLearningIntent() inside its own transaction, so this
   * field is filled by re-querying after materialization.
   */
  rate_event_id: string;
  hub_learning_item_id: string;
  atomic_learning_item_ids: string[];
  hub_artifact_id: string;
  atomic_artifact_ids: string[];
  root_knowledge_id: string;
  created_knowledge_ids: string[];
  idempotent?: boolean;
}

export type DismissAiProposalResult =
  | KnowledgeEdgeProposalDecisionResult
  | {
      kind: 'dismissed';
      rate_event_id: string | null;
      idempotent?: boolean;
    };

export interface RetractAiProposalResult {
  kind: 'retracted';
  correction_event_id: string;
}

export interface AcceptAiProposalOpts {
  decision?: Exclude<EdgeProposalDecision, 'dismiss'>;
  new_relation_type?: RelationTypeSchemaT;
  user_note?: string;
  // YUK-17 — swappable enqueue (DB tests inject a no-op or vi.fn).
  enqueueVariantVerify?: EnqueueVariantVerifyFn;
}

export interface DismissAiProposalOpts {
  user_note?: string;
}

export interface RetractAiProposalOpts {
  reason_md?: string;
  affected_refs?: ActivityRefT[];
}

function proposalNotFound(proposalId: string): ApiError {
  return new ApiError('not_found', `proposal ${proposalId} not found`, 404);
}

async function requireProposal(db: Db, proposalId: string): Promise<ProposalInboxRow> {
  const proposal = await getProposalInboxRow(db, proposalId);
  if (!proposal) throw proposalNotFound(proposalId);
  return proposal;
}

function assertPending(proposal: ProposalInboxRow): void {
  if (proposal.status !== 'pending') {
    throw new ApiError(
      'not_pending',
      `proposal ${proposal.id} is not pending (status=${proposal.status})`,
      409,
    );
  }
}

type ExistingRateDecision = 'accept' | 'dismiss' | 'reverse' | 'change_type' | 'rollback';

async function findExistingRateEvent(
  db: Db,
  proposalId: string,
): Promise<(typeof event.$inferSelect & { decision: ExistingRateDecision }) | null> {
  const existingRows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const existing = existingRows[0];
  const rating = (existing?.payload as { rating?: unknown } | undefined)?.rating;
  if (
    !existing ||
    (rating !== 'accept' &&
      rating !== 'dismiss' &&
      rating !== 'reverse' &&
      rating !== 'change_type' &&
      rating !== 'rollback')
  ) {
    return null;
  }
  const decision: ExistingRateDecision = rating;
  return Object.assign(existing, { decision });
}

async function reconcileExistingRateSignal(
  db: Db,
  proposal: ProposalInboxRow,
  userNote?: string,
): Promise<void> {
  const existingRate = await findExistingRateEvent(db, proposal.id);
  if (!existingRate) return;
  if (existingRate.decision === 'dismiss') {
    const ratePayload = existingRate.payload as { user_note?: string };
    await ensureProposalDecisionSignal(db, proposal, 'dismiss', userNote ?? ratePayload.user_note);
    return;
  }
  if (
    existingRate.decision === 'accept' ||
    existingRate.decision === 'reverse' ||
    existingRate.decision === 'change_type'
  ) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', userNote);
  }
}

function assertEdgeDecisionInput(input: EdgeProposalDecisionInput): void {
  if (input.decision === 'change_type' && !input.new_relation_type) {
    throw new ApiError('validation_error', 'change_type requires new_relation_type', 400);
  }
}

export async function decideKnowledgeEdgeProposal(
  db: Db,
  proposeEventId: string,
  input: EdgeProposalDecisionInput,
): Promise<KnowledgeEdgeProposalDecisionResult> {
  assertEdgeDecisionInput(input);
  const { decision, new_relation_type, user_note } = input;

  const proposeRows = await db.select().from(event).where(eq(event.id, proposeEventId)).limit(1);
  const proposeRow = proposeRows[0];
  if (!proposeRow) {
    throw new ApiError('not_found', `propose event ${proposeEventId} not found`, 404);
  }
  if (proposeRow.action !== 'propose' || proposeRow.subject_kind !== 'knowledge_edge') {
    throw new ApiError(
      'validation_error',
      `event ${proposeEventId} is not a knowledge_edge proposal (action=${proposeRow.action}, subject_kind=${proposeRow.subject_kind})`,
      400,
    );
  }
  const proposal = await getProposalInboxRow(db, proposeEventId);
  const proposePayload = proposeRow.payload as {
    from_knowledge_id: string;
    to_knowledge_id: string;
    relation_type: string;
    weight?: number;
    reasoning?: string;
  };
  const proposeSubjectId = proposeRow.subject_id;

  const existingRate = await findExistingRateEvent(db, proposeEventId);
  if (existingRate) {
    if (existingRate.decision !== decision) {
      throw new ApiError(
        'conflict',
        `proposal ${proposeEventId} already decided as ${existingRate.decision}`,
        409,
      );
    }
    if (proposal) {
      await ensureProposalDecisionSignal(
        db,
        proposal,
        decision === 'dismiss' ? 'dismiss' : 'accept',
        user_note,
      );
    }
    const existingGenRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'generate'),
          eq(event.subject_kind, 'knowledge_edge'),
          eq(event.caused_by_event_id, proposeEventId),
        ),
      )
      .limit(1);
    const gen = existingGenRows[0];
    return {
      kind: 'knowledge_edge',
      rate_event_id: existingRate.id,
      generate_event_id: gen?.id ?? null,
      edge_id: gen?.subject_id ?? null,
      idempotent: true,
    };
  }

  const now = new Date();
  const rateEventId = createId();

  if (decision === 'dismiss') {
    await writeEvent(db, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: proposeSubjectId,
      outcome: 'success',
      payload: {
        rating: 'dismiss',
        ...(user_note ? { user_note } : {}),
      },
      caused_by_event_id: proposeEventId,
      created_at: now,
    });
    if (proposal) {
      await recordProposalDecisionSignal(db, proposal, 'dismiss', user_note);
    }
    return {
      kind: 'knowledge_edge',
      rate_event_id: rateEventId,
      generate_event_id: null,
      edge_id: null,
    };
  }

  const fromId =
    decision === 'reverse' ? proposePayload.to_knowledge_id : proposePayload.from_knowledge_id;
  const toId =
    decision === 'reverse' ? proposePayload.from_knowledge_id : proposePayload.to_knowledge_id;
  const relationType =
    decision === 'change_type' ? (new_relation_type as string) : proposePayload.relation_type;
  const weight = proposePayload.weight ?? 1;

  const endpointIds = Array.from(new Set([fromId, toId]));
  const found = await db
    .select({ id: knowledge.id, archived_at: knowledge.archived_at })
    .from(knowledge)
    .where(inArray(knowledge.id, endpointIds));
  const foundActive = new Set(found.filter((r) => r.archived_at === null).map((r) => r.id));
  const missing = endpointIds.filter((id) => !foundActive.has(id));
  if (missing.length > 0) {
    throw new ApiError(
      'not_found',
      `unknown or archived knowledge_id(s): ${missing.join(', ')}`,
      404,
    );
  }

  const edgeId = createId();
  const generateEventId = createId();

  try {
    await db.transaction(async (tx) => {
      await writeEvent(tx, {
        id: rateEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'knowledge_edge',
        subject_id: proposeSubjectId,
        outcome: 'success',
        payload: {
          rating: decision,
          ...(decision === 'reverse' ? { new_direction_reversed: true } : {}),
          ...(decision === 'change_type' ? { new_relation_type: relationType } : {}),
          ...(user_note ? { user_note } : {}),
        },
        caused_by_event_id: proposeEventId,
        created_at: now,
      });

      await tx.insert(knowledge_edge).values({
        id: edgeId,
        from_knowledge_id: fromId,
        to_knowledge_id: toId,
        relation_type: relationType,
        weight,
        created_by: {
          actor_kind: 'user',
          actor_ref: 'self',
          propose_event_id: proposeEventId,
        } as never,
        reasoning: proposePayload.reasoning ?? null,
        created_at: now,
      });

      await writeEvent(tx, {
        id: generateEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'generate',
        subject_kind: 'knowledge_edge',
        subject_id: edgeId,
        outcome: 'success',
        payload: {
          from_knowledge_id: fromId,
          to_knowledge_id: toId,
          relation_type: relationType,
          weight,
          reasoning: proposePayload.reasoning ?? '',
          propose_event_id: proposeEventId,
        },
        caused_by_event_id: proposeEventId,
        created_at: now,
      });
    });
  } catch (err) {
    const pgCode =
      (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (pgCode === '23505') {
      throw new ApiError(
        'conflict',
        `edge already exists: ${fromId} --${relationType}--> ${toId}`,
        409,
      );
    }
    throw err;
  }

  if (proposal) {
    await recordProposalDecisionSignal(db, proposal, 'accept', user_note);
  }

  return {
    kind: 'knowledge_edge',
    rate_event_id: rateEventId,
    generate_event_id: generateEventId,
    edge_id: edgeId,
  };
}

export async function acceptAiProposal(
  db: Db,
  proposalId: string,
  opts: AcceptAiProposalOpts = {},
): Promise<AcceptAiProposalResult> {
  const proposal = await requireProposal(db, proposalId);
  if (proposal.status !== 'pending') {
    const existingRate = await findExistingRateEvent(db, proposal.id);
    if (!existingRate) {
      assertPending(proposal);
    }
    if (existingRate.decision !== 'accept') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} already decided as ${existingRate.decision}`,
        409,
      );
    }
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  }

  const result = await dispatchAccept(db, proposalId, proposal, opts);

  // YUK-15 — flip cited records linked/raw → actioned. Best-effort: kind
  // handlers already committed their owner-service tx, so this runs after.
  // For edge proposals decided as 'dismiss' (via decideKnowledgeEdgeProposal)
  // we still call this — the helper's `from` filter ('linked' / 'raw') means
  // dismissed records that never reached `actioned` are a no-op, and we don't
  // want to thread decision info further down.
  const recordIds = extractRecordEvidenceIds(proposal.payload.evidence_refs);
  if (recordIds.length > 0 && !isDismissedEdgeResult(result)) {
    await markRecordsActioned(db, recordIds);
  }
  return result;
}

function isDismissedEdgeResult(result: AcceptAiProposalResult): boolean {
  return (
    result.kind === 'knowledge_edge' && result.generate_event_id === null && result.edge_id === null
  );
}

async function dispatchAccept(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: AcceptAiProposalOpts,
): Promise<AcceptAiProposalResult> {
  switch (proposal.kind) {
    case 'knowledge_node': {
      assertPending(proposal);
      if (opts.decision && opts.decision !== 'accept') {
        throw new ApiError(
          'validation_error',
          `knowledge_node proposal only supports accept, got ${opts.decision}`,
          400,
        );
      }
      const result = await acceptProposal(db, proposalId);
      await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
      return { kind: 'knowledge_node', result };
    }
    case 'knowledge_edge':
      return await decideKnowledgeEdgeProposal(db, proposalId, {
        decision: opts.decision ?? 'accept',
        new_relation_type: opts.new_relation_type,
        user_note: opts.user_note,
      });
    case 'variant_question':
      return await acceptVariantQuestionProposal(db, proposalId, proposal, opts);
    case 'learning_item':
      return await acceptLearningItemProposal(db, proposalId, proposal, opts);
    default:
      throw new ApiError(
        'unsupported_proposal_kind',
        `accept is not implemented for proposal kind ${proposal.kind}; YUK-44 owns remaining producer semantics`,
        400,
      );
  }
}

/**
 * YUK-19 — learning_item accept materializes a 1-hub + N-atomic LearningItem
 * hierarchy + paired note artifacts through the existing acceptLearningIntent
 * owner service (Phase 2B). acceptLearningIntent writes its own rate event
 * inside the same transaction as the hierarchy/artifact inserts, so this
 * branch must not write a second rate event.
 *
 * If the proposal already has an accept rate event (idempotency) we re-derive
 * the materialization result from the persisted rows. acceptLearningIntent's
 * own `proposal_already_rated` guard would otherwise throw on the second
 * call — we beat it to the punch.
 */
async function acceptLearningItemProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: AcceptAiProposalOpts,
): Promise<LearningItemAcceptResult> {
  if (opts.decision && opts.decision !== 'accept') {
    throw new ApiError(
      'validation_error',
      `learning_item proposal only supports accept, got ${opts.decision}`,
      400,
    );
  }

  const existingRateRows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const existingRate = existingRateRows[0];
  if (existingRate) {
    const ratePayload = existingRate.payload as { rating?: string };
    if (ratePayload.rating !== 'accept') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} already decided as ${ratePayload.rating}`,
        409,
      );
    }
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const summary = await summarizeLearningItemMaterialization(db, proposalId);
    return {
      kind: 'learning_item',
      rate_event_id: existingRate.id,
      ...summary,
      idempotent: true,
    };
  }

  const result: LearningIntentMaterializeResult = await acceptLearningIntent({ db, proposalId });
  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  const rateRows = await db
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const rateEventId = rateRows[0]?.id;
  if (!rateEventId) {
    throw new ApiError(
      'inconsistent_state',
      `acceptLearningIntent for ${proposalId} returned without writing a rate event`,
      500,
    );
  }

  return {
    kind: 'learning_item',
    rate_event_id: rateEventId,
    hub_learning_item_id: result.hub_learning_item_id,
    atomic_learning_item_ids: result.atomic_learning_item_ids,
    hub_artifact_id: result.hub_artifact_id,
    atomic_artifact_ids: result.atomic_artifact_ids,
    root_knowledge_id: result.root_knowledge_id,
    created_knowledge_ids: result.created_knowledge_ids,
  };
}

/**
 * Re-derive the LearningIntentMaterializeResult from persisted rows for the
 * idempotent return path. Hub is the row whose `parent_learning_item_id` is
 * null among the learning_items rooted at the proposal id; atomics are its
 * children. Artifacts mirror.
 */
async function summarizeLearningItemMaterialization(
  db: Db,
  proposalId: string,
): Promise<Omit<LearningIntentMaterializeResult, 'enqueued_note_generate_jobs'>> {
  const liRows = await db
    .select({
      id: learning_item.id,
      parent_learning_item_id: learning_item.parent_learning_item_id,
      primary_artifact_id: learning_item.primary_artifact_id,
      knowledge_ids: learning_item.knowledge_ids,
    })
    .from(learning_item)
    .where(eq(learning_item.source_ref, proposalId));
  const hub = liRows.find((row) => row.parent_learning_item_id === null);
  if (!hub) {
    throw new ApiError(
      'inconsistent_state',
      `no hub learning_item found for proposal ${proposalId}`,
      500,
    );
  }
  const atomics = liRows.filter((row) => row.id !== hub.id);

  const hubArtifactId = hub.primary_artifact_id ?? null;
  if (!hubArtifactId) {
    throw new ApiError(
      'inconsistent_state',
      `hub learning_item ${hub.id} has no primary_artifact_id`,
      500,
    );
  }
  const rootKnowledgeId = hub.knowledge_ids[0] ?? null;
  if (!rootKnowledgeId) {
    throw new ApiError(
      'inconsistent_state',
      `hub learning_item ${hub.id} has no knowledge_id`,
      500,
    );
  }

  const atomicArtifactIds = atomics
    .map((row) => row.primary_artifact_id)
    .filter((id): id is string => Boolean(id));

  return {
    hub_learning_item_id: hub.id,
    atomic_learning_item_ids: atomics.map((row) => row.id),
    hub_artifact_id: hubArtifactId,
    atomic_artifact_ids: atomicArtifactIds,
    root_knowledge_id: rootKnowledgeId,
    created_knowledge_ids: [],
  };
}

/**
 * YUK-17 / ADR-0018 — variant_question accept materializes the question row
 * (source='mistake_variant', draft_status='active'), flips the mistake_variant
 * row from 'draft' to 'active', writes the rate event, and enqueues
 * VariantVerifyTask. The question + mistake_variant + rate-event writes share
 * one transaction so the row never sits half-materialized.
 */
async function acceptVariantQuestionProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: AcceptAiProposalOpts,
): Promise<VariantQuestionAcceptResult> {
  if (opts.decision && opts.decision !== 'accept') {
    throw new ApiError(
      'validation_error',
      `variant_question proposal only supports accept, got ${opts.decision}`,
      400,
    );
  }

  // Already-accepted idempotency: a rate event exists.
  const existingRateRows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const existingRate = existingRateRows[0];
  if (existingRate) {
    const ratePayload = existingRate.payload as { rating?: string };
    if (ratePayload.rating !== 'accept') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} already decided as ${ratePayload.rating}`,
        409,
      );
    }
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const existingMv = (
      await db
        .select()
        .from(mistake_variant)
        .where(eq(mistake_variant.proposal_event_id, proposalId))
        .limit(1)
    )[0];
    if (!existingMv || !existingMv.variant_question_id) {
      // Rate was written but materialization did not complete — caller should
      // retract + re-run, not silently fix up. Surface explicitly.
      throw new ApiError(
        'inconsistent_state',
        `proposal ${proposalId} has a rate event but no materialized variant; retract + retry`,
        500,
      );
    }
    return {
      kind: 'variant_question',
      rate_event_id: existingRate.id,
      question_id: existingMv.variant_question_id,
      mistake_variant_id: existingMv.id,
      idempotent: true,
    };
  }

  const proposedChange = proposal.payload.proposed_change as {
    source_question_id?: string;
    source_attempt_event_id?: string;
    prompt_md?: string;
    reference_md?: string;
    difficulty?: number;
    knowledge_ids?: string[];
    parent_variant_id?: string;
    root_question_id?: string;
    variant_depth?: number;
  };
  if (
    !proposedChange?.prompt_md ||
    !proposedChange.reference_md ||
    typeof proposedChange.difficulty !== 'number' ||
    !proposedChange.source_question_id
  ) {
    throw new ApiError(
      'validation_error',
      `variant_question proposal ${proposalId} is missing required proposed_change fields`,
      400,
    );
  }

  const mvRows = await db
    .select()
    .from(mistake_variant)
    .where(eq(mistake_variant.proposal_event_id, proposalId))
    .limit(1);
  const mv = mvRows[0];
  if (!mv) {
    throw new ApiError(
      'not_found',
      `no mistake_variant draft row found for proposal ${proposalId}; variant_gen may not have written it`,
      404,
    );
  }
  if (mv.status !== 'draft') {
    throw new ApiError(
      'conflict',
      `mistake_variant ${mv.id} is in status ${mv.status}, expected 'draft'`,
      409,
    );
  }

  const now = new Date();
  const newQuestionId = createId();
  const rateEventId = newId();

  await db.transaction(async (tx) => {
    await tx.insert(question).values({
      id: newQuestionId,
      kind: 'short_answer',
      prompt_md: proposedChange.prompt_md as string,
      reference_md: proposedChange.reference_md ?? null,
      knowledge_ids: proposedChange.knowledge_ids ?? [],
      difficulty: proposedChange.difficulty as number,
      source: 'mistake_variant',
      draft_status: 'active',
      variant_depth: proposedChange.variant_depth ?? 1,
      root_question_id: proposedChange.root_question_id ?? null,
      parent_variant_id: proposedChange.parent_variant_id ?? null,
      created_by: {
        by: 'ai',
        task_kind: 'VariantGenTask',
        propose_event_id: proposalId,
      } as never,
      created_at: now,
      updated_at: now,
    });

    await tx
      .update(mistake_variant)
      .set({
        status: 'active',
        variant_question_id: newQuestionId,
        updated_at: now,
      })
      .where(eq(mistake_variant.id, mv.id));

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
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
        materialized_question_id: newQuestionId,
        mistake_variant_id: mv.id,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  const enqueue = opts.enqueueVariantVerify ?? defaultEnqueueVariantVerify;
  try {
    await enqueue(mv.id);
  } catch (err) {
    // Mirror attribution_followup → variant_gen wiring: enqueue failure must
    // not roll back the accepted variant. Operator can re-enqueue later.
    console.error('[acceptVariantQuestionProposal] enqueue variant_verify failed', err);
  }

  return {
    kind: 'variant_question',
    rate_event_id: rateEventId,
    question_id: newQuestionId,
    mistake_variant_id: mv.id,
  };
}

async function writeGenericRateEvent(
  db: Db,
  proposalId: string,
  rating: 'accept' | 'dismiss',
  userNote?: string,
): Promise<{ rate_event_id: string | null; idempotent?: boolean }> {
  const existingRows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const existing = existingRows[0];
  if (existing) {
    const payload = existing.payload as { rating?: string };
    if (payload.rating !== rating) {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} already decided as ${payload.rating}`,
        409,
      );
    }
    return { rate_event_id: existing.id, idempotent: true };
  }

  const rateEventId = newId();
  await writeEvent(db, {
    id: rateEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: {
      rating,
      ...(userNote ? { user_note: userNote } : {}),
    },
    caused_by_event_id: proposalId,
    created_at: new Date(),
  });
  return { rate_event_id: rateEventId };
}

export async function dismissAiProposal(
  db: Db,
  proposalId: string,
  opts: DismissAiProposalOpts = {},
): Promise<DismissAiProposalResult> {
  const proposal = await requireProposal(db, proposalId);
  if (proposal.status !== 'pending') {
    const existingRate = await findExistingRateEvent(db, proposalId);
    if (existingRate?.decision && existingRate.decision !== 'dismiss') {
      throw new ApiError(
        'conflict',
        `proposal ${proposalId} already decided as ${existingRate.decision}`,
        409,
      );
    }
    await reconcileExistingRateSignal(db, proposal, opts.user_note);
    return { kind: 'dismissed', rate_event_id: existingRate?.id ?? null, idempotent: true };
  }

  switch (proposal.kind) {
    case 'knowledge_node':
      await dismissProposal(db, proposalId);
      await recordProposalDecisionSignal(db, proposal, 'dismiss', opts.user_note);
      return { kind: 'dismissed', rate_event_id: null };
    case 'knowledge_edge':
      return await decideKnowledgeEdgeProposal(db, proposalId, {
        decision: 'dismiss',
        user_note: opts.user_note,
      });
    case 'variant_question': {
      const result = await writeGenericRateEvent(db, proposalId, 'dismiss', opts.user_note);
      if (!result.idempotent) {
        // Flip the draft mistake_variant row to 'dismissed' so the in-flight
        // count (variants_max=3) frees up the slot.
        await db
          .update(mistake_variant)
          .set({ status: 'dismissed', updated_at: new Date() })
          .where(
            and(
              eq(mistake_variant.proposal_event_id, proposalId),
              eq(mistake_variant.status, 'draft'),
            ),
          );
        await recordProposalDecisionSignal(db, proposal, 'dismiss', opts.user_note);
      }
      return { kind: 'dismissed', ...result };
    }
    case 'learning_item': {
      // YUK-19 — dismiss before accept just writes a rate event. There are no
      // materialized learning_items yet (the writeLearningItemProposal +
      // acceptLearningIntent transaction is the only producer of those rows),
      // so there's nothing to tombstone here.
      const result = await writeGenericRateEvent(db, proposalId, 'dismiss', opts.user_note);
      if (!result.idempotent) {
        await recordProposalDecisionSignal(db, proposal, 'dismiss', opts.user_note);
      }
      return { kind: 'dismissed', ...result };
    }
    default: {
      const result = await writeGenericRateEvent(db, proposalId, 'dismiss', opts.user_note);
      if (!result.idempotent) {
        await recordProposalDecisionSignal(db, proposal, 'dismiss', opts.user_note);
      }
      return { kind: 'dismissed', ...result };
    }
  }
}

function activityRefsForProposal(proposal: ProposalInboxRow): ActivityRefT[] {
  const direct = activityRefFromTarget(proposal.target.subject_kind, proposal.target.subject_id);
  if (direct) return [direct];

  for (const ref of proposal.payload.evidence_refs) {
    const activityRef = activityRefFromEvidence(ref);
    if (activityRef) return [activityRef];
  }

  return [{ kind: 'open_inquiry', id: proposal.id }];
}

function activityRefFromTarget(subjectKind: string, subjectId: string | null): ActivityRefT | null {
  if (!subjectId) return null;
  if (subjectKind === 'question') return { kind: 'question', id: subjectId };
  if (subjectKind === 'record') return { kind: 'record', id: subjectId };
  if (subjectKind === 'project_milestone') return { kind: 'project_milestone', id: subjectId };
  if (subjectKind === 'open_inquiry') return { kind: 'open_inquiry', id: subjectId };
  return null;
}

function activityRefFromEvidence(
  ref: AiProposalPayloadT['evidence_refs'][number],
): ActivityRefT | null {
  if (ref.kind === 'question') return { kind: 'question', id: ref.id };
  if (ref.kind === 'record') return { kind: 'record', id: ref.id };
  return null;
}

export async function retractAiProposal(
  db: Db,
  proposalId: string,
  opts: RetractAiProposalOpts = {},
): Promise<RetractAiProposalResult> {
  const proposal = await requireProposal(db, proposalId);
  const correctionEventId = newId();
  await writeEvent(db, {
    id: correctionEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: {
      correction_kind: 'retract',
      reason_md: opts.reason_md ?? 'proposal retracted from inbox',
      affected_refs: opts.affected_refs ?? activityRefsForProposal(proposal),
    },
    caused_by_event_id: proposalId,
    created_at: new Date(),
  });

  // YUK-17 / ADR-0018 — retracting a variant_question proposal frees the
  // in-flight slot regardless of where the row was in its lifecycle. We
  // intentionally accept that this also retracts already-active variants:
  // the proposal-level retract is an L3 correction and outweighs the
  // mistake_variant row, mirroring how retracted knowledge proposals also
  // tombstone their materialized rows.
  if (proposal.kind === 'variant_question') {
    await db
      .update(mistake_variant)
      .set({ status: 'dismissed', updated_at: new Date() })
      .where(
        and(
          eq(mistake_variant.proposal_event_id, proposalId),
          inArray(mistake_variant.status, ['draft', 'active']),
        ),
      );
  }

  // YUK-19 — retracting a learning_item proposal tombstones any materialized
  // hub + atomic learning_items + paired artifacts. Mirrors the variant_question
  // policy above: proposal-level retract is an L3 correction and outweighs the
  // downstream rows. Idempotent: rows that are already archived stay put so a
  // second retract doesn't bump archived_at / archived_reason.
  if (proposal.kind === 'learning_item') {
    const now = new Date();
    await db
      .update(learning_item)
      .set({
        archived_at: now,
        archived_reason: 'proposal_retracted',
        updated_at: now,
      })
      .where(and(eq(learning_item.source_ref, proposalId), isNull(learning_item.archived_at)));
    await db
      .update(artifact)
      .set({
        archived_at: now,
        updated_at: now,
      })
      .where(and(eq(artifact.source_ref, proposalId), isNull(artifact.archived_at)));
  }

  // YUK-15 — retract rolls cited records back from `actioned` to `linked`.
  // We keep them at `linked` rather than `raw` because the same record may
  // still be evidence for other active proposals (see follow-up B in plan).
  const recordIds = extractRecordEvidenceIds(proposal.payload.evidence_refs);
  if (recordIds.length > 0) {
    await rollbackRecordsActioned(db, recordIds);
  }

  return { kind: 'retracted', correction_event_id: correctionEventId };
}
