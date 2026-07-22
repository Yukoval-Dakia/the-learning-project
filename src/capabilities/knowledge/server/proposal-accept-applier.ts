import type { Db } from '@/db/client';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
} from '@/kernel/proposals';
import { ApiError } from '@/server/http/errors';
import { recordProposalDecisionSignal } from '@/server/proposals/signals';
import { acceptProposal } from './proposals';

async function acceptKnowledgeNode(
  db: Db,
  input: ProposalAcceptInput,
): Promise<ProposalAcceptResult> {
  const { proposal, proposalId } = input;
  if (proposal.payload.kind !== 'knowledge_node') {
    throw new ApiError(
      'validation_error',
      `knowledge_node applier received ${proposal.payload.kind} proposal`,
      400,
    );
  }
  if (input.decision && input.decision !== 'accept') {
    throw new ApiError(
      'validation_error',
      `knowledge_node proposal only supports accept, got ${input.decision}`,
      400,
    );
  }
  const signalProposal = { ...proposal, kind: proposal.payload.kind };
  if (proposal.status !== 'pending') {
    return { kind: 'knowledge_node', result: null, idempotent: true };
  }

  const result = await acceptProposal(db, proposalId);
  await recordProposalDecisionSignal(db, signalProposal, 'accept', input.user_note);
  return { kind: 'knowledge_node', result };
}

export const knowledgeNodeProposalAcceptApplier: ProposalAcceptApplier = (db, input) =>
  acceptKnowledgeNode(db as Db, input);
