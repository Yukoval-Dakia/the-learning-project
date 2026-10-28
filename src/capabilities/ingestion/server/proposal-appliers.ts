// Proposal accept appliers for ingestion. block_merge lives here; image_candidate
// delegates to ./image-candidate-accept. The shared dispatch only routes here.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { ensureAcceptOnly, existingAcceptRate } from '@/kernel/proposals/applier-helpers';
import {
  assertBlockMergeAdmission,
  blockMergeAdmissionError,
  evaluateBlockMergeAdmission,
  loadBlockMergeAdmissionContext,
} from '@/kernel/proposals/block-merge-admission';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/kernel/proposals/signals';
// Accept reuses the mergeQuestions primitive; no auto-merge path exists.
import { mergeQuestions } from './block-structured-edit';

// Declare only the fields this applier reads; AcceptAiProposalOpts assigns structurally.
export interface IngestionApplierOpts {
  decision?: string;
  user_note?: string;
  /** Explicit learner confirmation for the irreversible merge. */
  confirm_lossy?: boolean;
}

// rate_event_id and merged_count only on a written merge; idempotent on a second
// accept; stale plus skip_reason when mergeQuestions soft-rejects, so the UI can
// show a stale notice instead of throwing.
export interface BlockMergeAcceptResult {
  kind: 'block_merge';
  rate_event_id?: string;
  primary_block_id: string;
  merged_count?: number;
  idempotent?: boolean;
  stale?: boolean;
  skip_reason?: string;
}

/**
 * Accepts a block_merge proposal by reusing mergeQuestions. AI only proposes; the
 * merge runs here on explicit user accept.
 *
 * mergeQuestions opens its own transaction, so the merge commits first and the rate
 * event second. A crash between them is covered by the existing-rate check and by
 * merged blocks no longer being draft, so a retry cannot merge twice.
 *
 * Any skipped result means the proposal is stale: no rate event or decision signal,
 * just a stale notice. A block that left draft after the read returns the same
 * shape, covering the read-to-lock race.
 */
export async function acceptBlockMergeProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: IngestionApplierOpts,
): Promise<BlockMergeAcceptResult> {
  ensureAcceptOnly('block_merge', opts);
  // Narrow the payload to read block_merge with full types.
  if (proposal.payload.kind !== 'block_merge') {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} is not a block_merge proposal (kind=${proposal.payload.kind})`,
      400,
    );
  }
  const change = proposal.payload.proposed_change;
  const primaryBlockId = change.primary_block_id;
  const mergeBlockIds = change.merge_block_ids;
  // Mirror mergeQuestions' dedupe and primary removal so merged_count and
  // merged_block_ids match the block's merged_from_block_ids. The proposal payload
  // is unvalidated and may repeat ids or name the primary.
  const effectiveMergeIds = [...new Set(mergeBlockIds)].filter((id) => id !== primaryBlockId);

  // An existing accept rate means the merge already ran; do not merge again. A
  // non-accept decision throws 409.
  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    return {
      kind: 'block_merge',
      rate_event_id: existingRate.id,
      primary_block_id: primaryBlockId,
      merged_count: effectiveMergeIds.length,
      idempotent: true,
    };
  }

  // Admission is proven on the stored rows: same document, ordered adjacent pages,
  // deterministic continuity, no conflicting question number; model confidence never
  // counts. The merge is irreversible, so accept requires confirm_lossy. The proof
  // re-runs on locked rows inside mergeQuestions, which is authoritative.
  //
  // A block that already left draft answers stale, not 409: no rate or decision,
  // proposal stays pending. Other proof failures throw 409.
  const admissionInput = {
    primaryBlockId,
    mergeBlockIds,
    ingestionSessionId: change.ingestion_session_id,
  };
  const admissionCtx = await loadBlockMergeAdmissionContext(db, [primaryBlockId, ...mergeBlockIds]);
  const verdict = evaluateBlockMergeAdmission(admissionInput, admissionCtx);
  if (verdict.reason === 'not_draft') {
    return {
      kind: 'block_merge',
      primary_block_id: primaryBlockId,
      stale: true,
      skip_reason: 'skipped:not_draft',
    };
  }
  if (!verdict.eligible) {
    throw blockMergeAdmissionError(verdict);
  }

  if (opts.confirm_lossy !== true) {
    throw new ApiError('confirm_required', '合并后无法撤销', 409, undefined, {
      affected_block_count: verdict.affectedBlockCount,
    });
  }

  // Step 1: merge in its own transaction.
  const merge = await mergeQuestions(db, {
    actorRef: 'proposal:accept',
    // Accepting is a user action, so the edit event is attributed to the user.
    actorKind: 'user',
    primaryBlockId,
    mergeBlockIds,
    // Re-check under the row locks, before any write; a throw rolls back with no
    // mutation. Non-draft rows are soft-rejected by the draft guard first.
    admission: async ({ tx }) => {
      await assertBlockMergeAdmission(tx, admissionInput);
    },
  });

  // Any soft reject means stale: no rate event and no decision signal.
  if (merge.status !== 'written') {
    return {
      kind: 'block_merge',
      primary_block_id: primaryBlockId,
      stale: true,
      skip_reason: merge.status,
    };
  }

  // Step 2: record the accept rate and decision signal after the merge commits.
  const now = new Date();
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
      rating: 'accept',
      primary_block_id: primaryBlockId,
      merged_block_ids: effectiveMergeIds,
      ...(opts.user_note ? { user_note: opts.user_note } : {}),
    },
    caused_by_event_id: proposalId,
    created_at: now,
  });
  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return {
    kind: 'block_merge',
    rate_event_id: rateEventId,
    primary_block_id: primaryBlockId,
    merged_count: effectiveMergeIds.length,
  };
}
