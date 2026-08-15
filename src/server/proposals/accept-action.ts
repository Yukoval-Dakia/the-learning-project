import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import {
  type ProposalAcceptResult,
  type ProposalLifecycleResult,
  getProposalLifecycleOperation,
} from '@/kernel/proposals';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import { ensureProposalDecisionSignal } from '@/kernel/proposals/signals';
import { extractRecordEvidenceIds, markRecordsActioned } from '@/kernel/records/record-processing';
import type { AcceptAiProposalOpts } from './action-types';
import { findExistingRateEvent } from './applier-helpers';
import {
  assertPending,
  ownerInput,
  proposalLifecycleRegistry,
  requireProposal,
} from './lifecycle-context';

interface DispatchedAccept {
  result: ProposalLifecycleResult;
  lifecycleOutcome: 'accepted' | 'dismissed';
}

async function dispatchAccept(
  db: Db,
  proposal: ProposalInboxRow,
  opts: AcceptAiProposalOpts,
  runtime: unknown,
): Promise<DispatchedAccept> {
  const declaration = getProposalLifecycleOperation(
    proposalLifecycleRegistry,
    proposal.payload.kind,
    'accept',
  );
  if (!declaration) {
    throw new ApiError(
      'unsupported_proposal_kind',
      `accept is not implemented for proposal kind ${proposal.payload.kind}; YUK-44 owns remaining producer semantics`,
      400,
    );
  }
  if (opts.corrected_payload !== undefined && declaration.correctedPayload !== true) {
    throw new ApiError(
      'validation_error',
      `corrected_payload is not supported by the owner of proposal kind ${proposal.payload.kind}`,
      400,
    );
  }

  const applier = await declaration.load();
  let result: ProposalAcceptResult;
  if (opts.decision === 'change_type') {
    result = await applier(
      db,
      {
        proposalId: proposal.id,
        proposal: ownerInput(proposal),
        decision: opts.decision,
        new_relation_type: opts.new_relation_type,
        user_note: opts.user_note,
      },
      runtime,
    );
  } else if (opts.decision === 'reverse') {
    result = await applier(
      db,
      {
        proposalId: proposal.id,
        proposal: ownerInput(proposal),
        decision: opts.decision,
        user_note: opts.user_note,
      },
      runtime,
    );
  } else {
    result = await applier(
      db,
      {
        proposalId: proposal.id,
        proposal: ownerInput(proposal),
        decision: 'accept',
        user_note: opts.user_note,
        corrected_payload: opts.corrected_payload,
      },
      runtime,
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
    return {
      result: ownedResult,
      lifecycleOutcome: result.lifecycle_outcome ?? 'accepted',
    };
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

export async function acceptAiProposal(
  db: Db,
  proposalId: string,
  opts: AcceptAiProposalOpts = {},
): Promise<ProposalLifecycleResult> {
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

  const dispatched = await dispatchAccept(db, proposal, opts, opts);

  const recordIds = extractRecordEvidenceIds(proposal.payload.evidence_refs);
  if (recordIds.length > 0 && dispatched.lifecycleOutcome === 'accepted') {
    await markRecordsActioned(db, recordIds);
  }
  return dispatched.result;
}
