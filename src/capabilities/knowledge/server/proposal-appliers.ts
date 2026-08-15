import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptProposal,
  ProposalAcceptResult,
  ProposalDismissApplier,
  ProposalRetractApplier,
  ProposalRetractInput,
} from '@/kernel/proposals';
import { toProposalLifecycleResult } from '@/kernel/proposals';
import * as ownerRuntime from '@/server/proposals/owner-runtime';
import { decideKnowledgeEdgeProposal } from './edge-proposal-accept';
import { acceptProposal, applyArchive, dismissProposal } from './proposals';

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
  await dismissProposal(ownerDb, input.proposalId);
  await ownerRuntime.recordProposalDecisionSignal(
    ownerDb,
    signalProposal(input.proposal),
    'dismiss',
    input.user_note,
  );
  return {
    kind: input.proposal.payload.kind,
    result: { kind: 'dismissed', rate_event_id: null },
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

async function retractKnowledgeNode(tx: Tx, input: ProposalRetractInput): Promise<void> {
  const rate = await ownerRuntime.findExistingRateEvent(tx, input.proposalId);
  if (rate?.decision !== 'accept') return;

  const mintedIds = (rate.payload as { materialized_ids?: { knowledge?: unknown } })
    .materialized_ids?.knowledge;
  const nodeId = Array.isArray(mintedIds) && typeof mintedIds[0] === 'string' ? mintedIds[0] : null;
  if (!nodeId) return;

  const node = (
    await tx
      .select({ id: knowledge.id, version: knowledge.version })
      .from(knowledge)
      .where(and(eq(knowledge.id, nodeId), isNull(knowledge.archived_at)))
      .limit(1)
  )[0];
  if (!node) return;

  const archiveEventId = createId();
  const now = new Date();
  await applyArchive(
    tx,
    { mutation: 'archive', node_id: nodeId, expected_version: node.version },
    now,
  );
  await writeEvent(tx, {
    id: archiveEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:knowledge_archive',
    subject_kind: 'knowledge',
    subject_id: nodeId,
    outcome: 'success',
    payload: {
      node_id: nodeId,
      expected_version: node.version,
      reasoning: input.reason_md ?? 'knowledge_node proposal retracted',
    },
    caused_by_event_id: input.proposalId,
    created_at: now,
  });
  await writeEvent(tx, {
    id: createId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: archiveEventId,
    outcome: 'success',
    payload: { rating: 'accept' },
    caused_by_event_id: archiveEventId,
    created_at: now,
  });
  await ownerRuntime.assertCurrentKnowledgeNodeParity(tx, nodeId);
}

export const knowledgeNodeProposalRetractApplier: ProposalRetractApplier = (db, input) =>
  retractKnowledgeNode(db as Tx, input);
