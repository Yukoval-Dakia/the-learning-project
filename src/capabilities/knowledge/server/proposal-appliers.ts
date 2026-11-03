import type { Db, Tx } from '@/db/client';
import { ApiError } from '@/kernel/http';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptProposal,
  ProposalAcceptResult,
  ProposalDismissApplier,
  ProposalRetractApplier,
} from '@/kernel/proposals';
import { toProposalLifecycleResult } from '@/kernel/proposals';
import * as ownerRuntime from '@/server/proposals/owner-runtime';
import { decideKnowledgeEdgeProposal } from './edge-proposal-accept';
import { retractKnowledgeCreate } from './knowledge-archive-operation';
import { acceptProposal, dismissProposal } from './proposals';

function signalProposal(proposal: ProposalAcceptProposal) {
  return {
    ...proposal,
    kind: proposal.payload.kind,
  };
}

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
  if (proposal.status !== 'pending') {
    return {
      kind,
      result: { kind, result: null, idempotent: true },
      idempotent: true,
    };
  }

  const result = await acceptProposal(db, proposalId);
  await ownerRuntime.recordProposalDecisionSignal(
    db,
    signalProposal(proposal),
    'accept',
    input.user_note,
  );
  return { kind, result: { kind, result } };
}

export const knowledgeNodeProposalAcceptApplier: ProposalAcceptApplier = (db, input) =>
  acceptKnowledgeProposal(db as Db, input, 'knowledge_node');

export const knowledgeMutationProposalAcceptApplier: ProposalAcceptApplier = (db, input) =>
  acceptKnowledgeProposal(db as Db, input, 'knowledge_mutation');

export const knowledgeEdgeProposalAcceptApplier: ProposalAcceptApplier = async (db, input) => {
  const result = await decideKnowledgeEdgeProposal(db as Db, input.proposalId, {
    decision: input.decision ?? 'accept',
    new_relation_type: input.new_relation_type,
    user_note: input.user_note,
  });
  return {
    kind: 'knowledge_edge',
    result: toProposalLifecycleResult(result),
    lifecycle_outcome: result.generate_event_id === null ? 'dismissed' : 'accepted',
  };
};

export const knowledgeNodeProposalDismissApplier: ProposalDismissApplier = async (db, input) => {
  const ownerDb = db as Db;
  const { idempotent } = await dismissProposal(ownerDb, input.proposalId, input.user_note);
  if (!idempotent) {
    await ownerRuntime.recordProposalDecisionSignal(
      ownerDb,
      signalProposal(input.proposal),
      'dismiss',
      input.user_note,
    );
  }
  return {
    kind: input.proposal.payload.kind,
    result: { kind: 'dismissed', rate_event_id: null, ...(idempotent ? { idempotent: true } : {}) },
  };
};

export const knowledgeEdgeProposalDismissApplier: ProposalDismissApplier = async (db, input) => ({
  kind: input.proposal.payload.kind,
  result: toProposalLifecycleResult(
    await decideKnowledgeEdgeProposal(db as Db, input.proposalId, {
      decision: 'dismiss',
      user_note: input.user_note,
    }),
  ),
});

export const knowledgeNodeProposalRetractApplier: ProposalRetractApplier = async (db, input) => {
  const tx = db as Tx;
  const archived = await retractKnowledgeCreate(tx, input);
  if (archived) await ownerRuntime.assertCurrentKnowledgeNodeParity(tx, archived.node_id);
};
