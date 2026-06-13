import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull } from 'drizzle-orm';

// YUK-143 / ADR-0024 — North-Star goal_scope accept materializer.
import {
  type GoalScopeAcceptResult,
  acceptGoalScopeProposal,
} from '@/capabilities/agency/server/goals/accept';
// M4-T4 (YUK-319) — learning_item / completion / relearn accept appliers live
// in the agency capability package; this shell only routes to them.
import {
  type CompletionAcceptResult,
  type LearningItemAcceptResult,
  type RelearnAcceptResult,
  acceptCompletionProposal,
  acceptLearningItemProposal,
  acceptRelearnProposal,
} from '@/capabilities/agency/server/proposal-appliers';
// YUK-227 S3 Slice C (ADR-0002) — image_candidate accept is the SINGLE VLM 抽图 trigger
// (download → asset → VisionExtractTask → SourcedQuestion → source_verify). No auto path.
import {
  type ImageCandidateAcceptDeps,
  type ImageCandidateAcceptResult,
  acceptImageCandidateProposal,
} from '@/capabilities/ingestion/server/image-candidate-accept';
// M4-T4 (YUK-319) — block_merge accept applier lives in the ingestion
// capability package; this shell only routes to it.
import {
  type BlockMergeAcceptResult,
  acceptBlockMergeProposal,
} from '@/capabilities/ingestion/server/proposal-appliers';
// ADR-0032 D4-E1 (YUK-203) — edge archive accept routes through the single-owner
// edges module (raw knowledge_edge writes outside it are forbidden).
import { archiveKnowledgeEdge } from '@/capabilities/knowledge/server/edges';
import { acceptProposal, dismissProposal } from '@/capabilities/knowledge/server/proposals';
import { persistNoteRefineApply } from '@/capabilities/notes/server/note-refine-apply';
// M4-T4 (YUK-319) — variant_question / question_draft accept appliers live in
// the practice capability package; this shell only routes to them.
import {
  type EnqueueVariantVerifyFn,
  type QuestionDraftAcceptResult,
  type VariantQuestionAcceptResult,
  acceptQuestionDraftProposal,
  acceptVariantQuestionProposal,
} from '@/capabilities/practice/server/proposal-appliers';
import { newId } from '@/core/ids';
import type { ActivityRefT } from '@/core/schema/activity';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import { NotePatch } from '@/core/schema/note-patch';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import {
  artifact,
  event,
  goal,
  knowledge,
  knowledge_edge,
  learning_item,
  mistake_variant,
} from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
// YUK-15 — record→proposal evidence loop: accept flips cited records to
// `actioned`, retract rolls them back to `linked`.
import {
  extractRecordEvidenceIds,
  markRecordsActioned,
  rollbackRecordsActioned,
} from '@/server/records/record_processing';
import {
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  findExistingRateEvent,
  requiredString,
} from './applier-helpers';
import { type ProposalInboxRow, getProposalInboxRow } from './inbox';
// M4-T4 (YUK-319) — record_links / record_promotion appliers live in the D11
// legacy tombstone module (no live producer); this shell only routes to them.
import {
  type RecordLinksAcceptResult,
  type RecordPromotionAcceptResult,
  acceptRecordLinksProposal,
  acceptRecordPromotionProposal,
} from './legacy-record-appliers';
import { ensureProposalDecisionSignal, recordProposalDecisionSignal } from './signals';

// M4-T4 (YUK-319) — actions.ts is the proposal-lifecycle DISPATCH SHELL: each
// kind's accept case delegates to its owning capability package's applier
// (practice / agency / ingestion / knowledge / notes). Shared accept helpers
// live in ./applier-helpers — the sanctioned import surface for appliers.
//
// Declared-kind audit vs aiProposalKinds (2026-06-11): three kinds have a
// producer but NO accept applier — defer (producers.ts:262), archive
// (producers.ts:307 + knowledge/server/review.ts:191), judge_retraction
// (producers.ts:454). Their accept path stays the default-throw in
// dispatchAccept (`unsupported_proposal_kind`); YUK-44 owns the remaining
// producer semantics.

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
  | {
      kind: 'knowledge_mutation';
      result: Awaited<ReturnType<typeof acceptProposal>>;
    }
  | KnowledgeEdgeProposalDecisionResult
  | VariantQuestionAcceptResult
  | LearningItemAcceptResult
  | CompletionAcceptResult
  | RelearnAcceptResult
  | NoteUpdateAcceptResult
  | RecordLinksAcceptResult
  | RecordPromotionAcceptResult
  | GoalScopeAcceptResult
  | BlockMergeAcceptResult
  | ImageCandidateAcceptResult
  | QuestionDraftAcceptResult;

export interface NoteUpdateAcceptResult {
  kind: 'note_update';
  rate_event_id: string;
  artifact_id: string;
  apply_event_id: string | null;
  artifact_version: number | null;
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
  // YUK-227 S3 Slice C — image_candidate accept seams (download/VLM/enqueue/ledger).
  // DB tests inject stubs to drive the accept path without real R2 / model spend.
  imageCandidateDeps?: ImageCandidateAcceptDeps;
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
    // ADR-0032 D4-E1 (YUK-203) — edge_op discriminator on the raw event payload
    // (writer.ts stamps it; legacy events written before this field are absent →
    // treated as 'create' below, the backward-compatible default).
    edge_op?: 'create' | 'archive';
    archive_edge_id?: string;
    from_knowledge_id: string;
    to_knowledge_id: string;
    relation_type: string;
    weight?: number;
    reasoning?: string;
  };
  const edgeOp = proposePayload.edge_op ?? 'create';
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

  // P5.4 / YUK-143 (RB-8) — the folded `rubric_rejected` bucket must be truly
  // NON-EXECUTABLE. A rubric-rejected propose event carries no chained rate, so
  // it slips past the `existingRate` idempotency guard above; without this check
  // any caller with the propose event id could accept / reverse / change_type it
  // and write the knowledge_edge anyway, bypassing the Layer-1 rubric. Reject any
  // decision whose derived status is not `pending` (rubric_rejected, or any other
  // terminal status: accepted/dismissed/stale that reached here without a matching
  // rate row) BEFORE writing any rate or edge. A genuinely accepted/dismissed
  // proposal re-decided with the SAME decision is handled idempotently above; a
  // genuinely pending proposal is unaffected.
  if (proposal && proposal.status !== 'pending') {
    throw new ApiError(
      'not_pending',
      `proposal ${proposeEventId} is not pending (status=${proposal.status}); rubric-folded and terminal proposals are not executable`,
      409,
    );
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

  // ADR-0032 D4-E1 (YUK-203) — ARCHIVE accept. Soft-deletes the live edge named by
  // archive_edge_id (set archived_at via the single-owner edges module; never a
  // hard delete — 守 propose+correction-reversible 不变量). reverse / change_type
  // are CREATE-edge semantics and meaningless for an archive proposal; reject them.
  // Idempotency mirrors create: the existingRate guard above short-circuits a
  // re-accept, and archiveKnowledgeEdge itself is a NULL→now guarded no-op, so a
  // racing/duplicate accept that slips past the guard still cannot double-archive.
  if (edgeOp === 'archive') {
    if (decision !== 'accept') {
      throw new ApiError(
        'validation_error',
        `knowledge_edge archive proposal only supports accept/dismiss, got ${decision}`,
        400,
      );
    }
    const archiveEdgeId = proposePayload.archive_edge_id;
    if (!archiveEdgeId) {
      throw new ApiError(
        'validation_error',
        `edge archive proposal ${proposeEventId} missing archive_edge_id`,
        400,
      );
    }

    const generateEventId = createId();
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
          rating: 'accept',
          edge_op: 'archive',
          ...(user_note ? { user_note } : {}),
        },
        caused_by_event_id: proposeEventId,
        created_at: now,
      });

      // Single-owner soft-delete. Throws not_found if the edge id is unknown;
      // returns { archived:false } if it was already archived (idempotent).
      await archiveKnowledgeEdge(tx, archiveEdgeId);

      // Provenance + idempotency anchor: a `generate` event whose subject is the
      // archived edge, mirroring the create path so the re-decide guard above
      // returns a consistent { generate_event_id, edge_id }.
      await writeEvent(tx, {
        id: generateEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'generate',
        subject_kind: 'knowledge_edge',
        subject_id: archiveEdgeId,
        outcome: 'success',
        payload: {
          edge_op: 'archive',
          archive_edge_id: archiveEdgeId,
          from_knowledge_id: proposePayload.from_knowledge_id,
          to_knowledge_id: proposePayload.to_knowledge_id,
          relation_type: proposePayload.relation_type,
          reasoning: proposePayload.reasoning ?? '',
          propose_event_id: proposeEventId,
        },
        caused_by_event_id: proposeEventId,
        created_at: now,
      });
    });

    if (proposal) {
      await recordProposalDecisionSignal(db, proposal, 'accept', user_note);
    }

    return {
      kind: 'knowledge_edge',
      rate_event_id: rateEventId,
      generate_event_id: generateEventId,
      edge_id: archiveEdgeId,
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
    if (existingRate) {
      if (existingRate.decision !== 'accept') {
        throw new ApiError(
          'conflict',
          `proposal ${proposalId} already decided as ${existingRate.decision}`,
          409,
        );
      }
      await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    } else {
      assertPending(proposal);
    }
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
    case 'knowledge_mutation': {
      assertPending(proposal);
      if (opts.decision && opts.decision !== 'accept') {
        throw new ApiError(
          'validation_error',
          `knowledge_mutation proposal only supports accept, got ${opts.decision}`,
          400,
        );
      }
      const result = await acceptProposal(db, proposalId);
      await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
      return { kind: 'knowledge_mutation', result };
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
    case 'completion':
      return await acceptCompletionProposal(db, proposalId, proposal, opts);
    case 'relearn':
      return await acceptRelearnProposal(db, proposalId, proposal, opts);
    case 'note_update':
      return await acceptNoteUpdateProposal(db, proposalId, proposal, opts);
    case 'record_links':
      return await acceptRecordLinksProposal(db, proposalId, proposal, opts);
    case 'record_promotion':
      return await acceptRecordPromotionProposal(db, proposalId, proposal, opts);
    case 'goal_scope': {
      // YUK-143 / ADR-0024 — accept materializes the goal row + rate event.
      ensureAcceptOnly('goal_scope', opts);
      const result = await acceptGoalScopeProposal(db, proposalId, proposal, {
        user_note: opts.user_note,
      });
      if (result.idempotent) {
        await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
      } else {
        await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
      }
      return result;
    }
    case 'block_merge':
      return await acceptBlockMergeProposal(db, proposalId, proposal, opts);
    case 'image_candidate': {
      // YUK-227 S3 Slice C (ADR-0002) — the user explicitly accepts an image-type
      // source; this is the ONLY path that spends a VLM extraction on it.
      ensureAcceptOnly('image_candidate', opts);
      return await acceptImageCandidateProposal(db, proposalId, proposal, opts.imageCandidateDeps);
    }
    case 'question_draft':
      // ADR-0031 / YUK-304 (lane B) — promote the copilot-authored draft to
      // active + FSRS-enroll (决定5: accept = promotion; the row already exists).
      return await acceptQuestionDraftProposal(db, proposalId, proposal, opts);
    default:
      throw new ApiError(
        'unsupported_proposal_kind',
        `accept is not implemented for proposal kind ${proposal.kind}; YUK-44 owns remaining producer semantics`,
        400,
      );
  }
}

async function acceptNoteUpdateProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: AcceptAiProposalOpts,
): Promise<NoteUpdateAcceptResult> {
  ensureAcceptOnly('note_update', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const artifactId = requiredString(
    change.artifact_id ?? proposal.target.subject_id,
    'artifact_id',
    proposalId,
  );
  const patchParsed = NotePatch.safeParse(change.patch);
  if (!patchParsed.success) {
    throw new ApiError(
      'validation_error',
      `note_update proposal ${proposalId} has invalid proposed_change.patch: ${patchParsed.error.issues.map((i) => i.message).join('; ')}`,
      400,
    );
  }

  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const payload = existingRate.payload as {
      materialized_apply_event_id?: unknown;
      materialized_artifact_version?: unknown;
    };
    return {
      kind: 'note_update',
      rate_event_id: existingRate.id,
      artifact_id: artifactId,
      apply_event_id:
        typeof payload.materialized_apply_event_id === 'string'
          ? payload.materialized_apply_event_id
          : null,
      artifact_version:
        typeof payload.materialized_artifact_version === 'number'
          ? payload.materialized_artifact_version
          : null,
      idempotent: true,
    };
  }

  const now = new Date();
  const rateEventId = newId();
  let applyEventId: string | null = null;
  let artifactVersion: number | null = null;
  await db.transaction(async (tx) => {
    const applyResult = await persistNoteRefineApply({
      db: tx,
      artifactId,
      patch: patchParsed.data,
      triggerEventId: proposalId,
      actorRef: 'note_refine_accept',
      now,
    });
    if (applyResult.status !== 'applied') {
      throw new ApiError(
        'conflict',
        `note_update proposal ${proposalId} could not apply patch (${applyResult.status})`,
        409,
      );
    }
    applyEventId = applyResult.event_id ?? null;
    artifactVersion = applyResult.artifact_version ?? null;
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
        materialized_artifact_id: artifactId,
        materialized_apply_event_id: applyEventId,
        materialized_artifact_version: artifactVersion,
        ...(opts.user_note ? { user_note: opts.user_note } : {}),
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
  });

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return {
    kind: 'note_update',
    rate_event_id: rateEventId,
    artifact_id: artifactId,
    apply_event_id: applyEventId,
    artifact_version: artifactVersion,
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

  // YUK-143 / ADR-0024 — retracting a goal_scope proposal tombstones the
  // materialized goal to 'dormant' (the goal is the downstream materialization;
  // proposal-level retract is an L3 correction that outweighs it, mirroring the
  // variant_question / learning_item policy above). We dormant rather than hard
  // delete so the evidence chain (goal.source_ref → proposal) stays intact.
  // Idempotent: a goal already non-active stays put.
  if (proposal.kind === 'goal_scope' && proposal.target.subject_id) {
    const now = new Date();
    await db
      .update(goal)
      .set({ status: 'dormant', updated_at: now })
      .where(and(eq(goal.id, proposal.target.subject_id), eq(goal.status, 'active')));
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
