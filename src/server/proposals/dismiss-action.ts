import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { getProposalLifecycleOperation } from '@/kernel/proposals';
import type { DismissAiProposalOpts, DismissAiProposalResult } from './action-types';
import {
  acquireProposalDecisionLock,
  findExistingRateEvent,
  writeProposalRateEvent,
} from './applier-helpers';
import type { ProposalInboxRow } from './inbox';
import { ownerInput, proposalLifecycleRegistry, requireProposal } from './lifecycle-context';
import { ensureProposalDecisionSignal, recordProposalDecisionSignal } from './signals';

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

async function dispatchDismiss(
  db: Db,
  proposal: ProposalInboxRow,
  opts: DismissAiProposalOpts,
): Promise<DismissAiProposalResult> {
  const declaration = getProposalLifecycleOperation(
    proposalLifecycleRegistry,
    proposal.payload.kind,
    'dismiss',
  );
  if (declaration) {
    const applier = await declaration.load();
    const result = await applier(db, {
      proposalId: proposal.id,
      proposal: ownerInput(proposal),
      user_note: opts.user_note,
    });
    if (result.kind !== proposal.payload.kind) {
      throw new ApiError(
        'invalid_proposal_dismiss_result',
        `dismiss applier for ${proposal.payload.kind} returned ${result.kind}`,
        500,
      );
    }
    return result.result;
  }

  return db.transaction(async (tx) => {
    await acquireProposalDecisionLock(tx, proposal.id);
    const rate = await writeProposalRateEvent(tx, proposal.id, 'dismiss', opts.user_note);
    if (!rate.idempotent) {
      await recordProposalDecisionSignal(tx, proposal, 'dismiss', opts.user_note);
    }
    return {
      kind: 'dismissed',
      rate_event_id: rate.rate_event_id,
      ...(rate.idempotent ? { idempotent: true } : {}),
    };
  });
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
  return dispatchDismiss(db, proposal, opts);
}
