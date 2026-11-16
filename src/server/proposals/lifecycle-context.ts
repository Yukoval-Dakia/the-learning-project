import { capabilities } from '@/capabilities';
import { archiveProposalArtifacts } from '@/capabilities/notes/public';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { createProposalLifecycleRegistry } from '@/kernel/proposals';
import { type ProposalInboxRow, getProposalInboxRow } from '@/kernel/proposals/inbox';
import { getStartedBoss } from '@/server/boss/client';
import { assertCurrentKnowledgeNodeParity } from '@/server/projections/parity';

export const proposalLifecycleRegistry = createProposalLifecycleRegistry(capabilities);

/**
 * The runtime surface every lifecycle operation hands to owner appliers. Appliers
 * extract what they need from it — they never import this dispatcher or another
 * capability — so cross-capability and non-portable platform ops are wired here
 * once: boss enqueue for follow-up jobs, Notes archiving for kinds whose retract
 * retires artifacts, and the projections parity assert for kinds that must keep
 * fold == live row.
 */
export const proposalRuntimeSeams = {
  getBoss: getStartedBoss,
  archiveProposalArtifacts,
  assertCurrentKnowledgeNodeParity,
} as const;

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
