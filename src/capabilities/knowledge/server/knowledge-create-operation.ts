// Knowledge-owned accept of a `propose_new` (role=kc) proposal. One call mints the id,
// anchors it, writes the accept rate carrying the v1 `knowledge_operation` create fact,
// and projects the node — callers never assemble ids, anchors, rate payload or order.
// The caller holds the proposal lock, has checked the proposal is pending, and passes
// the single materialization instant it captured after locking. The rate is written
// through the decision template's `writeRate` so it stays the one decision rate.

import { normalizeKnowledgeNodeName } from '@/core/knowledge-name';
import type { Tx } from '@/db/client';
import { acquireSortedAdvisoryLocks } from '@/db/learning-state-lock';
import type { ProposalRateWrite } from '@/kernel/proposals/decision-protocol';
import {
  prepareProposedKnowledgeId,
  projectKnowledgeNodeGuarded,
} from '@/kernel/records/knowledge-node-materialization';
import { upsertMaterializedIdIndex } from '@/kernel/records/materialized-id-index';
import { sanitizeProposedNodeDomain } from '@/subjects/profile';
import { findLiveSameNameKnowledgeNodes } from './knowledge-name-dedup';

export interface AcceptKnowledgeCreateInput {
  proposalId: string;
  payload: { name: string; parent_id: string | null; domain?: string };
  now: Date;
  /** The decision transaction's rate writer (runProposalAccept ctx.writeRate). */
  writeRate: (rate: ProposalRateWrite) => Promise<string>;
}

export async function acceptKnowledgeCreate(
  tx: Tx,
  input: AcceptKnowledgeCreateInput,
): Promise<{ new_node_id: string }> {
  const { proposalId, payload, now, writeRate } = input;

  // Per-proposal decision locks never serialize two accepts against each other,
  // and the parent's FOR SHARE in prepareProposedKnowledgeId does not block a
  // sibling create either. A same-(scope,name) advisory key does: the second
  // accept observes the first's committed row and fails back to human review.
  const scope = payload.parent_id ?? `root:${payload.domain ?? ''}`;
  await acquireSortedAdvisoryLocks(tx, 'knowledge:create-name', [
    `${scope}:${normalizeKnowledgeNodeName(payload.name)}`,
  ]);
  const [existing] = await findLiveSameNameKnowledgeNodes(tx, {
    name: payload.name,
    parentId: payload.parent_id,
    ...(payload.parent_id === null
      ? { domain: sanitizeProposedNodeDomain(payload.domain) ?? undefined }
      : {}),
  });
  if (existing) {
    throw new Error(
      `conflict: a live node already exists under this parent with this name (${existing.id})`,
    );
  }

  const newNodeId = await prepareProposedKnowledgeId(tx, payload);

  // First-write-wins reverse index; anchor = the propose event id.
  await upsertMaterializedIdIndex(tx, {
    materialized_id: newNodeId,
    anchor_event_id: proposalId,
    subject_kind: 'knowledge',
  });

  // The accept shares `now` so fold(events) reproduces the row's created_at/updated_at
  // exactly. materialized_ids is the legacy compat field: exactly the create targets.
  await writeRate({
    created_at: now,
    payload: {
      materialized_ids: { knowledge: [newNodeId] },
      knowledge_operation: {
        version: 1,
        kind: 'create',
        proposal_event_id: proposalId,
        targets: [{ kind: 'knowledge', id: newNodeId, effect: 'create' }],
      },
    },
  });

  await projectKnowledgeNodeGuarded(tx, newNodeId);
  return { new_node_id: newNodeId };
}
