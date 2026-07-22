import type { Db } from '@/db/client';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
} from '@/kernel/proposals';
import { ApiError } from '@/server/http/errors';
import { recordProposalDecisionSignal } from '@/server/proposals/signals';
import { acceptProposal } from './proposals';

async function acceptKnowledgeProposal(
  db: Db,
  input: ProposalAcceptInput,
  kind: 'knowledge_node' | 'knowledge_mutation',
): Promise<ProposalAcceptResult> {
  const { proposal, proposalId } = input;
  if (proposal.payload.kind !== kind) {
    throw new ApiError(
      'validation_error',
      `${kind} applier received ${proposal.payload.kind} proposal`,
      400,
    );
  }
  if (input.decision && input.decision !== 'accept') {
    throw new ApiError(
      'validation_error',
      `${kind} proposal only supports accept, got ${input.decision}`,
      400,
    );
  }
  const signalProposal = { ...proposal, kind: proposal.payload.kind };
  if (proposal.status !== 'pending') {
    return { kind, result: null, idempotent: true };
  }

  const result = await acceptProposal(db, proposalId);
  await recordProposalDecisionSignal(db, signalProposal, 'accept', input.user_note);
  return { kind, result };
}

export const knowledgeNodeProposalAcceptApplier: ProposalAcceptApplier = (db, input) =>
  acceptKnowledgeProposal(db as Db, input, 'knowledge_node');

export const knowledgeMutationProposalAcceptApplier: ProposalAcceptApplier = (db, input) =>
  acceptKnowledgeProposal(db as Db, input, 'knowledge_mutation');
