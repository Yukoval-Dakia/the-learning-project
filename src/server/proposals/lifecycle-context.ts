import { capabilities } from '@/capabilities';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { type ProposalAcceptProposal, createProposalLifecycleRegistry } from '@/kernel/proposals';
import { type ProposalInboxRow, getProposalInboxRow } from './inbox';

export const proposalLifecycleRegistry = createProposalLifecycleRegistry(capabilities);

export async function requireProposal(db: Db, proposalId: string): Promise<ProposalInboxRow> {
  const proposal = await getProposalInboxRow(db, proposalId);
  if (!proposal) throw new ApiError('not_found', `proposal ${proposalId} not found`, 404);
  return proposal;
}

export function assertPending(proposal: ProposalInboxRow): void {
  if (proposal.status !== 'pending') {
    throw new ApiError(
      'not_pending',
      `proposal ${proposal.id} is not pending (status=${proposal.status})`,
      409,
    );
  }
}

export function ownerInput(proposal: ProposalInboxRow): ProposalAcceptProposal {
  return {
    id: proposal.id,
    payload: proposal.payload,
    status: proposal.status,
    actor_ref: proposal.actor_ref,
  };
}
