// Knowledge-owned accept of a `propose_new` (role=kc) proposal. One call mints the id,
// anchors it, writes the accept rate carrying the v1 `knowledge_operation` create fact,
// and projects the node — callers never assemble ids, anchors, rate payload or order.
// The caller holds the proposal lock, has checked the proposal is pending, and passes
// the single materialization instant it captured after locking.

import { newId } from '@/core/ids';
import type { Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import {
  prepareProposedKnowledgeId,
  projectKnowledgeNodeGuarded,
} from '@/kernel/records/knowledge-node-materialization';
import { upsertMaterializedIdIndex } from '@/kernel/records/materialized-id-index';

export interface AcceptKnowledgeCreateInput {
  proposalId: string;
  payload: { parent_id: string | null; domain?: string };
  now: Date;
}

export async function acceptKnowledgeCreate(
  tx: Tx,
  input: AcceptKnowledgeCreateInput,
): Promise<{ new_node_id: string }> {
  const { proposalId, payload, now } = input;
  const newNodeId = await prepareProposedKnowledgeId(tx, payload);

  // First-write-wins reverse index; anchor = the propose event id.
  await upsertMaterializedIdIndex(tx, {
    materialized_id: newNodeId,
    anchor_event_id: proposalId,
    subject_kind: 'knowledge',
  });

  // The accept shares `now` so fold(events) reproduces the row's created_at/updated_at
  // exactly. materialized_ids is the legacy compat field: exactly the create targets.
  await writeEvent(tx, {
    id: newId(),
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: {
      rating: 'accept',
      materialized_ids: { knowledge: [newNodeId] },
      knowledge_operation: {
        version: 1,
        kind: 'create',
        proposal_event_id: proposalId,
        targets: [{ kind: 'knowledge', id: newNodeId, effect: 'create' }],
      },
    },
    caused_by_event_id: proposalId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });

  await projectKnowledgeNodeGuarded(tx, newNodeId);
  return { new_node_id: newNodeId };
}
