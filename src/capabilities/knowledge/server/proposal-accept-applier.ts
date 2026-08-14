import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
  ProposalDismissInput,
} from '@/kernel/proposals';
import * as ownerRuntime from '@/server/proposals/owner-runtime';
import type { ProposalInboxRow } from '@/server/proposals/owner-runtime';
import { createKnowledgeProposalLifecycle } from './proposal-lifecycle';
import { acceptProposal } from './proposals';

const {
  knowledgeEdgeProposalDismissApplier,
  knowledgeNodeProposalDismissApplier,
  knowledgeNodeProposalRetractApplier,
} = createKnowledgeProposalLifecycle({
  ...ownerRuntime,
  recordDismissSignal: (db: Db, input: ProposalDismissInput) =>
    ownerRuntime.recordProposalDecisionSignal(
      db,
      {
        ...input.proposal,
        kind: input.proposal.payload.kind,
        target: input.proposal.payload.target,
      } as ProposalInboxRow,
      'dismiss',
      input.user_note,
    ),
});

export {
  knowledgeEdgeProposalDismissApplier,
  knowledgeNodeProposalDismissApplier,
  knowledgeNodeProposalRetractApplier,
};

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
    return {
      kind,
      result: { kind, result: null, idempotent: true },
      idempotent: true,
    };
  }

  const result = await acceptProposal(db, proposalId);
  await ownerRuntime.recordProposalDecisionSignal(db, signalProposal, 'accept', input.user_note);
  return { kind, result: { kind, result } };
}

export const knowledgeNodeProposalAcceptApplier: ProposalAcceptApplier = (db, input) =>
  acceptKnowledgeProposal(db as Db, input, 'knowledge_node');

export const knowledgeMutationProposalAcceptApplier: ProposalAcceptApplier = (db, input) =>
  acceptKnowledgeProposal(db as Db, input, 'knowledge_mutation');
