import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { capabilities } from '@/capabilities';
import {
  type ProposalAcceptResult,
  createProposalAcceptRegistry,
  getProposalAcceptDecl,
} from '@/kernel/proposals';

import type {
  CompletionAcceptResult,
  ConjectureAcceptResult,
  EnqueueLearningIntentNoteFn,
  GoalScopeAcceptResult,
  LearningItemAcceptResult,
  RelearnAcceptResult,
} from '@/capabilities/agency/public';
import type {
  BlockMergeAcceptResult,
  ImageCandidateAcceptDeps,
  ImageCandidateAcceptResult,
  RecordLinksAcceptResult,
  RecordPromotionAcceptResult,
} from '@/capabilities/ingestion/public';
import {
  type EdgeProposalDecision,
  type EdgeProposalDecisionInput,
  type KnowledgeAcceptResult,
  type KnowledgeEdgeProposalDecisionResult,
  applyArchive,
  decideKnowledgeEdgeProposal,
  dismissProposal,
} from '@/capabilities/knowledge/public';
import { type NoteUpdateAcceptResult, undoNoteRefineApplyEvent } from '@/capabilities/notes/public';
import type {
  EnqueueVariantVerifyFn,
  QuestionDraftAcceptResult,
  QuestionEditAcceptResult,
  VariantQuestionAcceptResult,
} from '@/capabilities/practice/public';
import { newId } from '@/core/ids';
import type { ActivityRefT } from '@/core/schema/activity';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import {
  artifact,
  completion_evidence,
  event,
  goal,
  knowledge,
  knowledge_edge,
  learning_item,
  mistake_variant,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { emitArtifactLifecycleEvent } from '@/server/artifacts/mutation-events';
// YUK-471 W2 — goal retract write-through (guarded; projection writes the dormant goal when the
// per-entity flag is ON).
import { projectGoalGuarded } from '@/server/projections/goal';
// YUK-471 W2 — learning_item retract write-through (guarded; projection writes the archived row when
// the per-entity flag is ON).
import { projectLearningItemGuarded } from '@/server/projections/learning_item';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
// YUK-471 W2 — mistake_variant dismiss (E4) / retract (E5) write-through (guarded; projection writes
// the dismissed row when the per-entity flag is ON).
import { projectMistakeVariantGuarded } from '@/server/projections/mistake_variant';
// YUK-471 (retract fold/rollback) — knowledge_node retract mirrors the accept seam's in-tx
// fold==row gate: after the synthesized archive, re-project the node and assert fold == row
// (dev/test throws, prod warns) via the same node-snapshot mapper + assert the accept uses.
// YUK-471 W2 — goal retract OFF-branch parity assert + the A1 anchor gate (hasGoalGenesisAnchor).
import {
  assertGoalParity,
  assertKnowledgeNodeParity,
  assertLearningItemParity,
  assertMistakeVariantParity,
  goalLiveRowToSnapshot,
  hasGoalGenesisAnchor,
  hasLearningItemGenesisAnchor,
  hasMistakeVariantGenesisAnchor,
  knowledgeLiveRowToSnapshot,
  learningItemLiveRowToSnapshot,
  mistakeVariantLiveRowToSnapshot,
} from '@/server/projections/parity';
// YUK-471 W1 PR-B — the SoT-flip gate (default OFF; projection writes the edge row when ON).
import { projectionIsWriter } from '@/server/projections/sot-flag';
// YUK-15 — record→proposal evidence loop: accept flips cited records to
// `actioned`, retract rolls them back to `linked`.
import {
  extractRecordEvidenceIds,
  markRecordsActioned,
  rollbackRecordsActioned,
} from '@/server/records/record_processing';
import { acquireProposalDecisionLock, findExistingRateEvent } from './applier-helpers';
import { type ProposalInboxRow, getProposalInboxRow } from './inbox';
import { ensureProposalDecisionSignal, recordProposalDecisionSignal } from './signals';

const proposalAcceptRegistry = createProposalAcceptRegistry(capabilities);

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

export { decideKnowledgeEdgeProposal };
export type {
  EdgeProposalDecision,
  EdgeProposalDecisionInput,
  KnowledgeEdgeProposalDecisionResult,
};

export type AcceptAiProposalResult =
  | {
      kind: 'knowledge_node';
      result: KnowledgeAcceptResult | null;
      idempotent?: boolean;
    }
  | {
      kind: 'knowledge_mutation';
      result: KnowledgeAcceptResult | null;
      idempotent?: boolean;
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
  | QuestionDraftAcceptResult
  | QuestionEditAcceptResult
  | ConjectureAcceptResult;

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

export type AcceptAiProposalOpts = {
  user_note?: string;
  // YUK-17 — swappable enqueue (DB tests inject a no-op or vi.fn).
  enqueueVariantVerify?: EnqueueVariantVerifyFn;
  // YUK-604 — swappable note_generate enqueue; DB tests inject a spy while
  // production uses pg-boss with an artifact-keyed singleton window.
  enqueueLearningIntentNote?: EnqueueLearningIntentNoteFn;
  // YUK-227 S3 Slice C — image_candidate accept seams (download/VLM/enqueue/ledger).
  // DB tests inject stubs to drive the accept path without real R2 / model spend.
  imageCandidateDeps?: ImageCandidateAcceptDeps;
  // Phase 0 关系脑 (YUK-406 / YUK-440) — conjecture EDIT path: the owner-rewritten
  // claim (canonical field names). Presence routes the conjecture accept through
  // the corrected_by_owner branch (→ mem0 CORE write). The 备课台 route/UI wiring
  // that populates this is a neighboring task; this shell only consumes it.
  corrected_payload?: { claim_md: string };
} & (
  | { decision?: 'accept'; new_relation_type?: never }
  | { decision: 'reverse'; new_relation_type?: never }
  | { decision: 'change_type'; new_relation_type: RelationTypeSchemaT }
);

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
  const registered = getProposalAcceptDecl(proposalAcceptRegistry, proposal.payload.kind);
  if (!registered) {
    throw new ApiError(
      'unsupported_proposal_kind',
      `accept is not implemented for proposal kind ${proposal.payload.kind}; YUK-44 owns remaining producer semantics`,
      400,
    );
  }

  const applier = await registered.load();
  const proposalInput = {
    id: proposal.id,
    payload: proposal.payload,
    status: proposal.status,
    actor_ref: proposal.actor_ref,
  };
  let result: ProposalAcceptResult;
  if (opts.decision === 'change_type') {
    result = await applier(
      db,
      {
        proposalId,
        proposal: proposalInput,
        decision: opts.decision,
        new_relation_type: opts.new_relation_type,
        user_note: opts.user_note,
      },
      opts,
    );
  } else {
    result = await applier(
      db,
      {
        proposalId,
        proposal: proposalInput,
        decision: opts.decision,
        user_note: opts.user_note,
      },
      opts,
    );
  }
  const ownedResult = result.result;
  if (
    result.kind === proposal.payload.kind &&
    ownedResult !== null &&
    typeof ownedResult === 'object' &&
    'kind' in ownedResult &&
    ownedResult.kind === proposal.payload.kind
  ) {
    return ownedResult as AcceptAiProposalResult;
  }
  throw new ApiError(
    'invalid_proposal_accept_result',
    `accept applier for ${proposal.payload.kind} returned outer=${result.kind}, inner=${
      ownedResult && typeof ownedResult === 'object' && 'kind' in ownedResult
        ? String(ownedResult.kind)
        : typeof ownedResult
    }`,
    500,
  );
}

async function writeGenericRateEvent(
  db: Db,
  proposalId: string,
  rating: 'accept' | 'dismiss',
  userNote?: string,
): Promise<{ rate_event_id: string | null; idempotent?: boolean; rate_at: Date }> {
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
    return { rate_event_id: existing.id, idempotent: true, rate_at: existing.created_at };
  }

  const rateEventId = newId();
  // YUK-471 W2 — capture the rate event's created_at ONCE so a downstream imperative UPDATE (e.g.
  // the variant_question dismiss → mistake_variant.updated_at) can stamp the SAME value the fold
  // reads off this event. A second `new Date()` for the UPDATE would make fold(events) != live row
  // by a cross-ms delta → non-deterministic parity drift (the HIGH-1 double-clock guard the goal
  // retract slice established). Returned in `rate_at` (benign superset — existing callers ignore it).
  const rateAt = new Date();
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
    created_at: rateAt,
  });
  return { rate_event_id: rateEventId, rate_at: rateAt };
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
        //
        // YUK-471 W2 (E4) — the rate(dismiss) event is already written above (caused_by=proposalId,
        // rating='dismiss'), so the fold reproduces the dismissed row. ROW writer gated on the
        // per-entity flag (critic A1): ON → projectMistakeVariantGuarded folds (status→dismissed)
        // + writes through; OFF → the imperative dismiss UPDATE (current behavior) + the write-time
        // fold==row parity assert. The dismiss only acts on a DRAFT row (the WHERE guard), so an
        // already-accepted variant is untouched on both paths.
        // YUK-499 — wrap the draft-row flip + project in ONE tx and lock the draft row FOR UPDATE
        // (this dismiss path previously ran the row read + write-through on `db` in autocommit, with
        // no serialization). The rate(dismiss) event was already written above (visible to the
        // gather below). The lock serializes against a concurrent accept/verify/retract of the same
        // mv — projectMistakeVariantGuarded has no version-CAS, so without it a later gather could
        // miss an uncommitted event → stale fold → row drift. Wrapping also makes the OFF-path
        // UPDATE + parity assert atomic (a parity mismatch now rolls back the dismiss flip).
        await db.transaction(async (tx) => {
          const [draftMv] = await tx
            .select({ id: mistake_variant.id })
            .from(mistake_variant)
            .where(
              and(
                eq(mistake_variant.proposal_event_id, proposalId),
                eq(mistake_variant.status, 'draft'),
              ),
            )
            .for('update')
            .limit(1);
          if (draftMv) {
            if (projectionIsWriter('mistake_variant')) {
              await projectMistakeVariantGuarded(tx, draftMv.id);
            } else {
              // REUSE the rate(dismiss) event's created_at (result.rate_at) for updated_at so the
              // imperative row and the fold stamp the SAME value — fold(events) == live row
              // deterministically (HIGH-1 double-clock guard). Do NOT open a new `new Date()`.
              // rate_at is a non-optional return (both writeGenericRateEvent branches always set it),
              // so no `?? new Date()` fallback is needed — a fallback would silently reintroduce the
              // HIGH-1 double-clock drift if a future branch ever omitted it. (review NIT.)
              await tx
                .update(mistake_variant)
                .set({ status: 'dismissed', updated_at: result.rate_at })
                .where(
                  and(
                    eq(mistake_variant.proposal_event_id, proposalId),
                    eq(mistake_variant.status, 'draft'),
                  ),
                );
              // APPLICABILITY GATE — only assert for an EVENT-SOURCED variant (create-base/genesis/
              // index anchor); a pre-W2 / fixture row folds to null and would FALSE-mismatch.
              if (await hasMistakeVariantGenesisAnchor(tx, draftMv.id)) {
                const [written] = await tx
                  .select()
                  .from(mistake_variant)
                  .where(eq(mistake_variant.id, draftMv.id))
                  .limit(1);
                await assertMistakeVariantParity(
                  tx,
                  draftMv.id,
                  written ? mistakeVariantLiveRowToSnapshot(written) : null,
                );
              }
            }
          }
        });
        await recordProposalDecisionSignal(db, proposal, 'dismiss', opts.user_note);
      }
      // STRIP the internal rate_at timestamp at the HTTP boundary — it threads the OFF-path
      // updated_at reuse (above) but is NOT part of DismissAiProposalResult; leaking it would
      // surface an internal timestamp in the dismiss HTTP response (proposal-decide.ts JSONs the
      // whole result). (review LOW — rate_at is for internal clock-reuse only.)
      const { rate_at: _rateAt, ...rest } = result;
      return { kind: 'dismissed', ...rest };
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
      const { rate_at: _rateAt, ...rest } = result; // strip internal timestamp (see above)
      return { kind: 'dismissed', ...rest };
    }
    default: {
      const result = await writeGenericRateEvent(db, proposalId, 'dismiss', opts.user_note);
      if (!result.idempotent) {
        await recordProposalDecisionSignal(db, proposal, 'dismiss', opts.user_note);
      }
      const { rate_at: _rateAt, ...rest } = result; // strip internal timestamp (see above)
      return { kind: 'dismissed', ...rest };
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

  // YUK-471 (retract fold/rollback) — SINGLE retract transaction (augment#3 + OCR
  // relearn-tx). The `correct` event AND every kind-specific reversal below run in ONE
  // tx, so a throw anywhere (e.g. applyArchive version-mismatch, a parity-assert dev
  // throw) rolls back the WHOLE retract — never the half-state "correct event committed
  // but the materialized row not reversed". All reads/writes use `tx`; findExistingRateEvent
  // (immutable-event read) and undoNoteRefineApplyEvent (its internal tx becomes a nested
  // savepoint) were widened to Db|Tx to join this tx. The pre-existing kinds
  // (variant_question / learning_item / goal_scope) are folded in too — strictly safer,
  // behavior unchanged.
  await db.transaction(async (tx) => {
    // Serialize every proposal retraction with downstream lifecycle consumers that
    // derive effects from the accepted proposal. Conjecture probes use this shared
    // lock before committing evidence/follow-ups, so retract-vs-answer cannot leave
    // a live recurrence probe for a stale proposal.
    await acquireProposalDecisionLock(tx, proposalId);
    if (proposal.kind === 'question_edit') {
      const existingRate = await findExistingRateEvent(tx, proposalId);
      if (existingRate?.decision === 'accept') {
        throw new ApiError(
          'question_edit_retract_conflict',
          '题目修订已应用，无法安全撤销；请提交新的题目修订来纠正当前内容。',
          409,
        );
      }
    }

    // YUK-471 W2 — capture the correction timestamp ONCE so the goal_scope dormant UPDATE below
    // reuses the SAME value the `correct` event carries for updated_at. The goal reducer reads
    // updated_at off the correct event's created_at, so a separate `new Date()` for the imperative
    // UPDATE (a cross-ms delta across the writeEvent round-trip) would make fold(events) != live
    // row → non-deterministic audit:projection drift. Anchoring both on correctionAt keeps
    // fold==row deterministic.
    const correctionAt = new Date();
    await writeEvent(tx, {
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
      created_at: correctionAt,
    });

    // YUK-17 / ADR-0018 — retracting a variant_question proposal frees the
    // in-flight slot regardless of where the row was in its lifecycle. We
    // intentionally accept that this also retracts already-active variants:
    // the proposal-level retract is an L3 correction and outweighs the
    // mistake_variant row, mirroring how retracted knowledge proposals also
    // tombstone their materialized rows.
    //
    // YUK-471 W2 (E5) — the `correct` (retract) event was already appended at the top of this tx
    // (subject=the proposal, caused_by=proposalId, correction_kind='retract'), so the fold reproduces
    // the dismissed row from its create-base + chain. ROW writer gated on the per-entity flag (critic
    // A1): ON → projectMistakeVariantGuarded folds (status→dismissed) + writes through; OFF → the
    // imperative dismiss UPDATE (current behavior) + the write-time fold==row parity assert. The
    // UPDATE reuses correctionAt (the correct event's created_at) so the row + fold stamp the SAME
    // updated_at (HIGH-1 double-clock guard). The retract acts on draft|active rows on both paths.
    if (proposal.kind === 'variant_question') {
      const retractedMvs = await tx
        .select({ id: mistake_variant.id })
        .from(mistake_variant)
        .where(
          and(
            eq(mistake_variant.proposal_event_id, proposalId),
            inArray(mistake_variant.status, ['draft', 'active']),
          ),
        )
        // YUK-499 — lock the retracted rows FOR UPDATE so the project loop (ON, no version-CAS) /
        // imperative UPDATE serializes against a concurrent accept/verify/dismiss of the same mv.
        // Held for the whole retract tx, so the read→fold→write stays atomic per mv id.
        .for('update');
      if (projectionIsWriter('mistake_variant')) {
        for (const mv of retractedMvs) {
          await projectMistakeVariantGuarded(tx, mv.id);
        }
      } else {
        await tx
          .update(mistake_variant)
          .set({ status: 'dismissed', updated_at: correctionAt })
          .where(
            and(
              eq(mistake_variant.proposal_event_id, proposalId),
              inArray(mistake_variant.status, ['draft', 'active']),
            ),
          );
        for (const mv of retractedMvs) {
          // APPLICABILITY GATE — only assert for an EVENT-SOURCED variant (create-base/genesis/index
          // anchor); a pre-W2 / fixture row folds to null and would FALSE-mismatch.
          if (await hasMistakeVariantGenesisAnchor(tx, mv.id)) {
            const [written] = await tx
              .select()
              .from(mistake_variant)
              .where(eq(mistake_variant.id, mv.id))
              .limit(1);
            await assertMistakeVariantParity(
              tx,
              mv.id,
              written ? mistakeVariantLiveRowToSnapshot(written) : null,
            );
          }
        }
      }
    }

    // YUK-19 — retracting a learning_item proposal tombstones any materialized
    // hub + atomic learning_items + paired artifacts. Mirrors the variant_question
    // policy above: proposal-level retract is an L3 correction and outweighs the
    // downstream rows. Idempotent: rows that are already archived stay put so a
    // second retract doesn't bump archived_at / archived_reason.
    //
    // YUK-471 W2 — the learning_item rows are now fold-visible. For EACH affected item (a hub +
    // atomics + longs share source_ref=proposalId) we write a per-id experimental:learning_item_archive
    // action event (subject_kind='learning_item', created_at=correctionAt — the SINGLE CLOCK, HIGH-1:
    // the reducer derives archived_at + updated_at from THIS event's created_at and the imperative
    // UPDATE reuses the SAME correctionAt). A pre-W2 / un-backfilled item carries no genesis BASE, so
    // the archive event alone folds to null (no base to mutate) — to make fold==archived_row hold we
    // write a genesis-IF-MISSING (a snapshot of the CURRENT, not-yet-archived row) BEFORE the archive
    // event (design §3⑥ / §7.5; the anchor is captured before the action). ROW writer gated on the
    // per-entity flag (critic A1): ON → projectLearningItemGuarded folds (genesis + archive) + writes
    // through; OFF → the imperative UPDATE (current behavior — archived_at + archived_reason +
    // updated_at, NO version bump) + a write-time fold==row parity assert. All on the outer retract
    // `tx` (PR #592 tx-wrap) so the genesis + archive + UPDATE + the correct event are one atomic unit.
    if (proposal.kind === 'learning_item') {
      // Capture the affected items BEFORE the archive (the imperative WHERE: source_ref=proposalId AND
      // archived_at IS NULL). The genesis-if-missing snapshots the row in this not-yet-archived state.
      const affectedItems = await tx
        .select()
        .from(learning_item)
        .where(and(eq(learning_item.source_ref, proposalId), isNull(learning_item.archived_at)))
        // YUK-499 — lock the affected rows FOR UPDATE so the per-item genesis-if-missing +
        // archive event + project step serialize against concurrent learning_item writers. This
        // closes both the genesis check-then-insert race (a concurrent complete/relearn could create
        // a genesis between this scan and the inline hasLearningItemGenesisAnchor check below) and
        // the ON-path project TOCTOU. The lock is held for the whole retract tx.
        .for('update');
      const flip = projectionIsWriter('learning_item');
      for (const item of affectedItems) {
        // genesis-IF-MISSING — anchor a pre-W2 / un-backfilled item with a snapshot of its CURRENT
        // (not-yet-archived) state so the archive event has a base to fold from.
        if (!(await hasLearningItemGenesisAnchor(tx, item.id))) {
          const genesisEventId = newId();
          // CLAMP the genesis created_at STRICTLY EARLIER than the archive event (review #1 — LOW,
          // root-cause hardening). The fold sorts by (created_at asc, id asc) and event ids are
          // non-temporal cuid2s, so if item.updated_at == correctionAt (same-ms, cross-tx) the random
          // archive id could sort BEFORE the genesis → the archive would hit an absent/null row
          // (no-op) and the genesis would then seed an UN-archived row → fold.archived_at=null !=
          // live correctionAt (a false parity failure). min(item.updated_at, correctionAt - 1ms)
          // guarantees genesis < archive regardless of id, while staying ≤ the row's own time so the
          // seeded base still reproduces the pre-archive row.
          const genesisAt = new Date(
            Math.min(item.updated_at.getTime(), correctionAt.getTime() - 1),
          );
          await writeEvent(tx, {
            id: genesisEventId,
            actor_kind: 'system',
            actor_ref: 'genesis-backfill',
            action: 'experimental:genesis',
            subject_kind: 'learning_item',
            subject_id: item.id,
            outcome: 'success',
            payload: { row: learningItemLiveRowToSnapshot(item) },
            // strictly < archive so the genesis sorts BEFORE it (see the clamp rationale above).
            created_at: genesisAt,
            ingest_at: correctionAt,
          });
          await upsertMaterializedIdIndex(tx, {
            materialized_id: item.id,
            anchor_event_id: genesisEventId,
            subject_kind: 'learning_item',
          });
        }
        // The archive action event (created_at=correctionAt — single clock with the UPDATE below).
        await writeEvent(tx, {
          id: newId(),
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'experimental:learning_item_archive',
          subject_kind: 'learning_item',
          subject_id: item.id,
          outcome: 'success',
          payload: { reason: 'proposal_retracted' },
          caused_by_event_id: proposalId,
          created_at: correctionAt,
          ingest_at: correctionAt,
        });
      }
      if (flip) {
        for (const item of affectedItems) {
          await projectLearningItemGuarded(tx, item.id);
        }
      } else {
        // REUSE correctionAt (the archive event's created_at) so the imperative archived row and the
        // fold stamp the SAME archived_at/updated_at — fold(events) == live row deterministically.
        await tx
          .update(learning_item)
          .set({
            archived_at: correctionAt,
            archived_reason: 'proposal_retracted',
            updated_at: correctionAt,
          })
          .where(and(eq(learning_item.source_ref, proposalId), isNull(learning_item.archived_at)));
        for (const item of affectedItems) {
          // The item is event-sourced this tx (the genesis-if-missing + archive), so it always
          // re-folds — assert fold(events) == the archived row. dev/test throw on mismatch, prod warn.
          const [written] = await tx
            .select()
            .from(learning_item)
            .where(eq(learning_item.id, item.id))
            .limit(1);
          await assertLearningItemParity(
            tx,
            item.id,
            written ? learningItemLiveRowToSnapshot(written) : null,
          );
        }
      }
      // W3-C1γ (resolves the B2/C5 ⚠️ W3 COUPLING) — this retract ALSO archives the paired `artifact`
      // rows (source_ref=proposalId). Now that artifact is folded, the imperative archive ALSO emits a
      // fold-source lifecycle(archive) event per row (additive double-write; flag OFF). REUSE
      // correctionAt as the single fold clock (mirror the learning_item seam above) so the imperative
      // archived rows + the artifact fold stamp the SAME archived_at/updated_at — fold(events) == live
      // row deterministically. The UPDATE RETURNS the affected ids + versions (archive does NOT bump
      // version → next_version = the unchanged returned version). An artifact with no create/genesis
      // anchor (pre-W3) folds null regardless, so the event is a harmless extra there; once C2
      // backfills its genesis the archive becomes fold-visible.
      const archivedArtifacts = await tx
        .update(artifact)
        .set({
          archived_at: correctionAt,
          updated_at: correctionAt,
        })
        .where(and(eq(artifact.source_ref, proposalId), isNull(artifact.archived_at)))
        .returning({ id: artifact.id, version: artifact.version });
      for (const arch of archivedArtifacts) {
        await emitArtifactLifecycleEvent(tx, {
          subjectId: arch.id,
          op: 'archive',
          archivedAt: correctionAt,
          nextVersion: arch.version,
          actorKind: 'user',
          actorRef: 'self',
          causedByEventId: proposalId,
          createdAt: correctionAt,
        });
      }
    }

    // YUK-143 / ADR-0024 — retracting a goal_scope proposal tombstones the
    // materialized goal to 'dormant' (the goal is the downstream materialization;
    // proposal-level retract is an L3 correction that outweighs it, mirroring the
    // variant_question / learning_item policy above). We dormant rather than hard
    // delete so the evidence chain (goal.source_ref → proposal) stays intact.
    // Idempotent: a goal already non-active stays put.
    //
    // YUK-471 W2 — the `correct` (retract) event was appended at the top of this tx
    // (subject=the proposal, caused_by=proposalId), so the goal fold reproduces the dormant row
    // from its proposal+rate+correct chain. ROW writer gated on the per-entity flag (critic A1):
    // ON → projectGoalGuarded folds (status→dormant, NO version bump) + writes through; OFF → the
    // imperative bare UPDATE (dormant + updated_at, no version bump). The reducer mirrors the bare
    // UPDATE exactly, so fold==row holds either way.
    if (proposal.kind === 'goal_scope' && proposal.target.subject_id) {
      const goalId = proposal.target.subject_id;
      // A1 (OCR major) — capture the genesis anchor for the OFF-branch parity gate BEFORE asserting.
      // The `correct` event written above is subject_kind='event' (NOT a goal anchor in
      // GOAL_ANCHOR_ACTIONS), so it does not flip this read: a goal with no genesis/proposal anchor
      // still reads false here and is correctly SKIPPED below (its fold is null and would
      // FALSE-mismatch the live row → assertGoalParity throws in dev/test).
      // YUK-499 — lock the goal row FOR UPDATE before the ROW write so this retract's project/UPDATE
      // serializes against a concurrent goal status/scope update (which also takes this lock). The
      // ON-path projectGoalGuarded has no version-CAS, so the lock is what keeps the read→fold→write
      // atomic per goal id. No-op cost on the OFF path. (A 0-row lock if the goal was already deleted.)
      await tx.select({ id: goal.id }).from(goal).where(eq(goal.id, goalId)).for('update');
      const wasGoalEventSourced = await hasGoalGenesisAnchor(tx, goalId);
      if (projectionIsWriter('goal')) {
        // ON: projectGoalGuarded's own anchor guard is intact here (the correct event is not a goal
        // anchor, so a base-less goal still folds null and is NOT deleted) — safe to call directly.
        await projectGoalGuarded(tx, goalId);
      } else {
        // REUSE the correct event's created_at (correctionAt) so the imperative dormant row and the
        // goal fold stamp the SAME updated_at — fold(events) == live row deterministically. Do NOT
        // open a new `new Date()`.
        await tx
          .update(goal)
          .set({ status: 'dormant', updated_at: correctionAt })
          .where(and(eq(goal.id, goalId), eq(goal.status, 'active')));
        // HIGH-2 + A1 — write-time fold==row guard, ONLY when the goal is event-sourced (a pre-W2
        // goal with no anchor folds null and would FALSE-mismatch its live row). dev/test throw on
        // mismatch, prod warn.
        if (wasGoalEventSourced) {
          const [written] = await tx.select().from(goal).where(eq(goal.id, goalId)).limit(1);
          await assertGoalParity(tx, goalId, written ? goalLiveRowToSnapshot(written) : null);
        }
      }
    }

    // YUK-471 (retract fold/rollback) — completion retract. An ACCEPTED completion
    // (acceptCompletionProposal) set the learning_item to status='done', stamped
    // completed_at, bumped version, and INSERTed an ai_propose completion_evidence row.
    // Retract reverses that: restore the EXACT pre-accept status + completed_at (pinned on
    // the rate=accept payload as materialized_prior_status / materialized_prior_completed_at
    // — completion accepts a pending OR in_progress item, so we restore the true prior one
    // instead of guessing), then DELETE the evidence row this proposal created (targeted by
    // learning_item_id + path='ai_propose' + evidence_json.proposal_id === proposalId,
    // exactly what the accept stamped). All on the outer retract `tx` — the SELECT-guard +
    // UPDATE + evidence DELETE + the correct event above are now one atomic unit.
    //
    // A still-proposed / dismissed completion never materialized (no rate=accept) → we skip,
    // leaving only the correct marker. IDEMPOTENCY / L3 trade-off: the version-guarded UPDATE
    // is keyed on status='done', so a SECOND retract of the SAME proposal is a no-op (the
    // item is no longer 'done'). It is NOT provenance-checked, so it does not verify the
    // current 'done' state was produced by THIS accept — a cross-proposal re-accept that
    // re-completed the item could be clobbered by a late retract. That matches the sibling
    // L3-retract policy (variant_question / learning_item / goal_scope): a proposal-level
    // retract is an L3 correction that outweighs the downstream row, with the correct event
    // as the durable audit trail. (learning_item is NOT event-sourced; no fold==row gate.)
    if (proposal.kind === 'completion') {
      const rate = await findExistingRateEvent(tx, proposalId);
      if (rate?.decision === 'accept') {
        const ratePayload = rate.payload as {
          materialized_learning_item_id?: unknown;
          materialized_prior_status?: unknown;
          materialized_prior_completed_at?: unknown;
        };
        const learningItemId = ratePayload.materialized_learning_item_id;
        if (typeof learningItemId === 'string' && learningItemId.length > 0) {
          // pre-prior-capture accepts (no pinned status) re-open to in_progress (safe,
          // actionable); with prior-capture the true prior (pending|in_progress) is restored.
          const priorStatus =
            typeof ratePayload.materialized_prior_status === 'string'
              ? ratePayload.materialized_prior_status
              : 'in_progress';
          const priorCompletedAt =
            typeof ratePayload.materialized_prior_completed_at === 'string'
              ? new Date(ratePayload.materialized_prior_completed_at)
              : null;
          const now = new Date();
          const item = (
            await tx
              .select({ id: learning_item.id, version: learning_item.version })
              .from(learning_item)
              .where(and(eq(learning_item.id, learningItemId), eq(learning_item.status, 'done')))
              .limit(1)
          )[0];
          if (item) {
            await tx
              .update(learning_item)
              .set({
                status: priorStatus,
                completed_at: priorCompletedAt,
                updated_at: now,
                version: item.version + 1,
              })
              .where(
                and(eq(learning_item.id, learningItemId), eq(learning_item.version, item.version)),
              );
          }
          // Tombstone the ai_propose evidence this proposal materialized. The table has no
          // archived_at column, so a hard DELETE of the proposal-scoped row is the reversal;
          // the correct event above is the durable audit trail of the retraction.
          await tx
            .delete(completion_evidence)
            .where(
              and(
                eq(completion_evidence.learning_item_id, learningItemId),
                eq(completion_evidence.path, 'ai_propose'),
                sql`${completion_evidence.evidence_json} ->> 'proposal_id' = ${proposalId}`,
              ),
            );
        }
      }
    }

    // YUK-471 (retract fold/rollback) — relearn retract. An ACCEPTED relearn
    // (acceptRelearnProposal) moved the item to status='in_progress' and cleared
    // completed_at (it had been done OR resting). Retract restores the EXACT pre-accept
    // status + completed_at pinned on the rate=accept payload. This is critical: relearn
    // accepts both `done` (completed_at set) and `resting` (completed_at null), so a naive
    // "restore to done + completed_at=now" would CORRUPT a `resting` item into `done` with a
    // fabricated timestamp (and contradict the relearn producer's rollback_plan, which says
    // keep a resting item resting). Restoring the captured prior state avoids that entirely.
    //
    // A non-accepted relearn never moved the item → skip. IDEMPOTENCY / L3 trade-off: same as
    // completion above — the version-guarded UPDATE keyed on status='in_progress' makes a
    // second retract of the same proposal a no-op, but is not provenance-checked against a
    // cross-proposal re-accept (sibling L3-retract policy; correct event is the audit trail).
    if (proposal.kind === 'relearn') {
      const rate = await findExistingRateEvent(tx, proposalId);
      if (rate?.decision === 'accept') {
        const ratePayload = rate.payload as {
          materialized_learning_item_id?: unknown;
          materialized_prior_status?: unknown;
          materialized_prior_completed_at?: unknown;
        };
        const learningItemId = ratePayload.materialized_learning_item_id;
        if (typeof learningItemId === 'string' && learningItemId.length > 0) {
          const hasPriorStatus = typeof ratePayload.materialized_prior_status === 'string';
          // Pre-prior-capture accepts (no pinned status) fall back to 'done' — the dominant
          // prior case before resting became reachable. With prior-capture, the exact state
          // (done or resting, with its real completed_at) is restored, so no corruption.
          const priorStatus = hasPriorStatus
            ? (ratePayload.materialized_prior_status as string)
            : 'done';
          // Resolve completed_at explicitly (was a nested ternary — OCR readability nit). The
          // resting-corruption guard lives here: only fall back to a synthetic `now` for the
          // LEGACY no-capture path; a captured null (e.g. resting) restores to null.
          let priorCompletedAt: Date | null;
          if (typeof ratePayload.materialized_prior_completed_at === 'string') {
            priorCompletedAt = new Date(ratePayload.materialized_prior_completed_at);
          } else if (hasPriorStatus) {
            priorCompletedAt = null; // captured prior, completed_at was NULL (e.g. resting)
          } else {
            priorCompletedAt = new Date(); // legacy: prior was 'done', original timestamp lost
          }
          const now = new Date();
          const item = (
            await tx
              .select({ id: learning_item.id, version: learning_item.version })
              .from(learning_item)
              .where(
                and(eq(learning_item.id, learningItemId), eq(learning_item.status, 'in_progress')),
              )
              .limit(1)
          )[0];
          if (item) {
            await tx
              .update(learning_item)
              .set({
                status: priorStatus,
                completed_at: priorCompletedAt,
                updated_at: now,
                version: item.version + 1,
              })
              .where(
                and(eq(learning_item.id, learningItemId), eq(learning_item.version, item.version)),
              );
          }
        }
      }
    }

    // YUK-471 (retract fold/rollback) — knowledge_node retract. An ACCEPTED knowledge_node
    // (acceptProposal → applyProposeNew) minted a NEW knowledge row (version 0) and anchored
    // it via materialized_id_index + the rate=accept's materialized_ids. Retract soft-deletes
    // that node. To preserve the project-critical fold(events)==row invariant we do BOTH, on
    // the outer retract `tx`, mirroring the imperative archive-accept seam:
    //   (a) append an `experimental:knowledge_archive` event (subject = node id) + its chained
    //       rate=accept — the node fold's archive branch consumes this pair and sets
    //       archived_at + version+1; and
    //   (b) imperatively applyArchive the row with the SAME `now`, so the row's archived_at /
    //       version match what the fold reproduces (fold(create + archive) == archived row).
    // The minted node id is read off the rate=accept payload.materialized_ids.knowledge (the
    // ONLY record of which id propose_new materialized). A still-proposed / dismissed node
    // never materialized → skip. Idempotent: applyArchive throws on an already-archived node,
    // so we guard on archived_at IS NULL before synthesizing the archive pair; a second retract
    // is a no-op (no new events, no version bump). Running on the outer tx (no inner
    // transaction) means a parity-assert throw or applyArchive version-mismatch rolls back the
    // WHOLE retract including the correct event — no "retracted but not reversed" half-state.
    // NOTE: knowledge_mutation retract (reparent/merge/split/archive of PRE-EXISTING nodes) is
    // intentionally NOT auto-reversed here — a generic parity-preserving inverse for those is
    // not available (the prior parent / merged_from / archived sibling state was not captured);
    // they keep only the correct marker (no row reversal, hence no fold==row regression).
    // Tracked as a YUK-471 follow-up.
    if (proposal.kind === 'knowledge_node') {
      const rate = await findExistingRateEvent(tx, proposalId);
      if (rate?.decision === 'accept') {
        const mintedIds = (rate.payload as { materialized_ids?: { knowledge?: unknown } })
          .materialized_ids?.knowledge;
        const nodeId =
          Array.isArray(mintedIds) && typeof mintedIds[0] === 'string' ? mintedIds[0] : null;
        if (nodeId) {
          const now = new Date();
          const node = (
            await tx
              .select({ id: knowledge.id, version: knowledge.version })
              .from(knowledge)
              .where(and(eq(knowledge.id, nodeId), isNull(knowledge.archived_at)))
              .limit(1)
          )[0];
          if (node) {
            const archiveEventId = createId();
            const archiveRateId = createId();
            // (b) imperative soft-delete (single-owner applyArchive: archived_at + version+1).
            await applyArchive(
              tx,
              { mutation: 'archive', node_id: nodeId, expected_version: node.version },
              now,
            );
            // (a) fold-visible archive event + chained rate=accept so the node fold reproduces
            // the archived row. Payload shape MUST match KnowledgeArchivePayload
            // ({ node_id, expected_version, reasoning }) — the fold validates it.
            await writeEvent(tx, {
              id: archiveEventId,
              actor_kind: 'user',
              actor_ref: 'self',
              action: 'experimental:knowledge_archive',
              subject_kind: 'knowledge',
              subject_id: nodeId,
              outcome: 'success',
              payload: {
                node_id: nodeId,
                expected_version: node.version,
                reasoning: opts.reason_md ?? 'knowledge_node proposal retracted',
              },
              caused_by_event_id: proposalId,
              created_at: now,
            });
            await writeEvent(tx, {
              id: archiveRateId,
              actor_kind: 'user',
              actor_ref: 'self',
              action: 'rate',
              subject_kind: 'event',
              subject_id: archiveEventId,
              outcome: 'success',
              payload: { rating: 'accept' },
              caused_by_event_id: archiveEventId,
              created_at: now,
            });

            // YUK-471 (retract fold/rollback) — in-tx parity gate, mirroring the accept seam.
            // Re-read the just-archived row and assert fold(create + this archive)==row inside
            // the SAME tx (so the gather sees the archive event + its chained rate). Dev/test
            // THROW on divergence (catch a broken synthesized-archive seam immediately); prod
            // warn+return (never break a live retract over a fold bug — see parity.ts). The
            // offline B3 auditor is the backstop, but this gives retract the same dev guard.
            const archivedRow = (
              await tx.select().from(knowledge).where(eq(knowledge.id, nodeId)).limit(1)
            )[0];
            await assertKnowledgeNodeParity(
              tx,
              nodeId,
              archivedRow ? knowledgeLiveRowToSnapshot(archivedRow) : null,
            );
          }
        }
      }
    }

    // YUK-358 / ADR-0040 决定1 — the undo chain. Retracting a note_update proposal
    // that was already APPLIED (accepted → acceptNoteUpdateProposal → persistNoteRefineApply
    // mutated artifact.body_blocks) must reverse that mutation, restoring the prior
    // body_blocks + version from the reverse payload persistNoteRefineApply stored on
    // the apply event. This mirrors how variant_question / learning_item / goal_scope
    // retracts above reverse their materialized downstream rows.
    //
    // The accept path records the materialized apply event id on its rate event
    // (payload.materialized_apply_event_id), so we look it up there. A still-proposed
    // (never-accepted) or dismissed note_update never applied → no rate-accept → no
    // apply event id → nothing to reverse, and we skip. undoNoteRefineApplyEvent is
    // idempotent (already-undone / version_conflict short-circuit) and resyncs the L2
    // backlink index; passing the outer `tx` makes its internal transaction a nested
    // SAVEPOINT so the undo joins this single atomic retract.
    if (proposal.kind === 'note_update') {
      const rate = await findExistingRateEvent(tx, proposalId);
      const applyEventId =
        rate?.decision === 'accept'
          ? (rate.payload as { materialized_apply_event_id?: unknown }).materialized_apply_event_id
          : undefined;
      if (typeof applyEventId === 'string' && applyEventId.length > 0) {
        await undoNoteRefineApplyEvent(tx, { applyEventId });
      }
    }

    // YUK-15 — retract rolls cited records back from `actioned` to `linked`.
    // We keep them at `linked` rather than `raw` because the same record may
    // still be evidence for other active proposals (see follow-up B in plan).
    const recordIds = extractRecordEvidenceIds(proposal.payload.evidence_refs);
    if (recordIds.length > 0) {
      await rollbackRecordsActioned(tx, recordIds);
    }
  });

  return { kind: 'retracted', correction_event_id: correctionEventId };
}
