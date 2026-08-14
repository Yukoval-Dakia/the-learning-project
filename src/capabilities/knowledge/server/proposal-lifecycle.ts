import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type {
  ProposalDismissApplier,
  ProposalDismissInput,
  ProposalRetractApplier,
  ProposalRetractInput,
} from '@/kernel/proposals';
import { toProposalLifecycleResult } from '@/kernel/proposals';
import { decideKnowledgeEdgeProposal } from './edge-proposal-accept';
import { applyArchive, dismissProposal } from './proposals';

interface KnowledgeLifecycleRuntime {
  assertCurrentKnowledgeNodeParity: (tx: Tx, nodeId: string) => Promise<void>;
  findExistingRateEvent: (
    tx: Tx,
    proposalId: string,
  ) => Promise<{ decision: string; payload: unknown } | null>;
  recordDismissSignal: (db: Db, input: ProposalDismissInput) => Promise<void>;
}

async function retractKnowledgeNode(
  tx: Tx,
  input: ProposalRetractInput,
  runtime: KnowledgeLifecycleRuntime,
): Promise<void> {
  const rate = await runtime.findExistingRateEvent(tx, input.proposalId);
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
  await runtime.assertCurrentKnowledgeNodeParity(tx, nodeId);
}

export function createKnowledgeProposalLifecycle(runtime: KnowledgeLifecycleRuntime): {
  knowledgeNodeProposalDismissApplier: ProposalDismissApplier;
  knowledgeEdgeProposalDismissApplier: ProposalDismissApplier;
  knowledgeNodeProposalRetractApplier: ProposalRetractApplier;
} {
  return {
    knowledgeNodeProposalDismissApplier: async (db, input) => {
      const ownerDb = db as Db;
      await dismissProposal(ownerDb, input.proposalId);
      await runtime.recordDismissSignal(ownerDb, input);
      return {
        kind: input.proposal.payload.kind,
        result: { kind: 'dismissed', rate_event_id: null },
      };
    },
    knowledgeEdgeProposalDismissApplier: async (db, input) => ({
      kind: input.proposal.payload.kind,
      result: toProposalLifecycleResult(
        await decideKnowledgeEdgeProposal(db as Db, input.proposalId, {
          decision: 'dismiss',
          user_note: input.user_note,
        }),
      ),
    }),
    knowledgeNodeProposalRetractApplier: (db, input) =>
      retractKnowledgeNode(db as Tx, input, runtime),
  };
}
