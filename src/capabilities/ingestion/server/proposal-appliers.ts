// Proposal accept appliers for ingestion. block_merge lives here. The shared
// dispatch only routes here.

import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { ensureAcceptOnly } from '@/kernel/proposals/applier-helpers';
import {
  assertBlockMergeAdmission,
  blockMergeAdmissionError,
  evaluateBlockMergeAdmission,
  loadBlockMergeAdmissionContext,
} from '@/kernel/proposals/block-merge-admission';
import {
  type ProposalAcceptEffectOutcome,
  type RecordedProposalRate,
  SkippedProposalDecision,
  runProposalAccept,
} from '@/kernel/proposals/decision-protocol';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
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
 * The merge (a savepoint inside mergeQuestions) and the rate event commit in the
 * kernel decision transaction, under the lock the generic dismiss takes, so a racing
 * accept or dismiss cannot write a second rate.
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

  const admissionInput = {
    primaryBlockId,
    mergeBlockIds,
    ingestionSessionId: change.ingestion_session_id,
  };
  const staleResult = (skipReason: string): BlockMergeAcceptResult => ({
    kind: 'block_merge',
    primary_block_id: primaryBlockId,
    stale: true,
    skip_reason: skipReason,
  });

  // An existing accept rate means the merge already ran; do not merge again. A
  // non-accept decision throws 409.
  const { result } = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'after_commit',
    replay: async (rate: RecordedProposalRate): Promise<BlockMergeAcceptResult> => ({
      kind: 'block_merge',
      rate_event_id: rate.id,
      primary_block_id: primaryBlockId,
      merged_count: effectiveMergeIds.length,
      idempotent: true,
    }),
    // Admission is proven on the stored rows: same document, ordered adjacent pages,
    // deterministic continuity, no conflicting question number; model confidence never
    // counts. The merge is irreversible, so accept requires confirm_lossy. The proof
    // re-runs on locked rows inside mergeQuestions, which is authoritative.
    //
    // A block that already left draft answers stale, not 409: no rate or decision,
    // proposal stays pending. Other proof failures throw 409.
    prepare: async () => {
      const admissionCtx = await loadBlockMergeAdmissionContext(db, [
        primaryBlockId,
        ...mergeBlockIds,
      ]);
      const verdict = evaluateBlockMergeAdmission(admissionInput, admissionCtx);
      if (verdict.reason === 'not_draft') {
        return new SkippedProposalDecision(staleResult('skipped:not_draft'));
      }
      if (!verdict.eligible) {
        throw blockMergeAdmissionError(verdict);
      }
      if (opts.confirm_lossy !== true) {
        throw new ApiError('confirm_required', '合并后无法撤销', 409, undefined, {
          affected_block_count: verdict.affectedBlockCount,
        });
      }
      return undefined;
    },
    effect: async ({
      tx,
      writeRate,
    }): Promise<ProposalAcceptEffectOutcome<BlockMergeAcceptResult>> => {
      const merge = await mergeQuestions(tx, {
        actorRef: 'proposal:accept',
        // Accepting is a user action, so the edit event is attributed to the user.
        actorKind: 'user',
        primaryBlockId,
        mergeBlockIds,
        // Re-check under the row locks, before any write; a throw rolls back with no
        // mutation. Non-draft rows are soft-rejected by the draft guard first.
        admission: async ({ tx: mergeTx }) => {
          await assertBlockMergeAdmission(mergeTx, admissionInput);
        },
      });
      // Any soft reject means stale: no rate event and no decision signal.
      if (merge.status !== 'written') {
        return { status: 'skipped', result: staleResult(merge.status) };
      }

      const rateEventId = await writeRate({
        payload: { primary_block_id: primaryBlockId, merged_block_ids: effectiveMergeIds },
      });
      return {
        status: 'accepted',
        result: {
          kind: 'block_merge',
          rate_event_id: rateEventId,
          primary_block_id: primaryBlockId,
          merged_count: effectiveMergeIds.length,
        },
      };
    },
  });
  return result;
}
