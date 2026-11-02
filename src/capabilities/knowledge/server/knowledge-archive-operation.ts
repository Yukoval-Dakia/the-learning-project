// Knowledge-owned retraction of an accepted `propose_new` node. Runs inside the caller's
// outer transaction after the cross-kind `correct` event (C) is written, and before the
// record rollback. Write order: node version/history guard → edge archive facts → node
// archive A → accept rate RA carrying the v1 `knowledge_operation` archive fact →
// projection. The caller asserts row/fold parity on the returned node right after, still
// inside the same transaction. The node is archived at its CURRENT valid version, never rewound
// to the birth version, so later legitimate edits survive.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Tx } from '@/db/client';
import { event, knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { findExistingRateEvent } from '@/kernel/proposals/applier-helpers';
import { projectKnowledgeNodeGuarded } from '@/kernel/records/knowledge-node-materialization';
import { type RetiredKnowledgeEdge, prepareKnowledgeArchive } from './proposals';

export interface RetractKnowledgeCreateInput {
  proposalId: string;
  /** The `correct` event the caller already wrote; the archive fact cites it. */
  correction_event_id?: string;
  reason_md?: string;
}

// The edge archive events are written by the edge owner through its event_id port; read
// them back so the receipt only cites facts that exist and really archive these edges.
async function requireRetiredEdgeFacts(
  tx: Tx,
  nodeId: string,
  retired: readonly RetiredKnowledgeEdge[],
): Promise<void> {
  if (retired.length === 0) return;
  const rows = await tx
    .select()
    .from(event)
    .where(
      inArray(
        event.id,
        retired.map((r) => r.event_id),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const { edge_id, event_id } of retired) {
    const fact = byId.get(event_id);
    const payload = fact?.payload;
    if (
      !fact ||
      !payload ||
      fact.action !== 'generate' ||
      fact.subject_kind !== 'knowledge_edge' ||
      fact.subject_id !== edge_id ||
      payload.edge_op !== 'archive' ||
      payload.archive_edge_id !== edge_id ||
      (payload.from_knowledge_id !== nodeId && payload.to_knowledge_id !== nodeId)
    ) {
      throw new Error(`edge archive fact ${event_id} does not archive edge ${edge_id}`);
    }
  }
}

/** Resolves to the archived node id, or null when there is no active node to retract. */
export async function retractKnowledgeCreate(
  tx: Tx,
  input: RetractKnowledgeCreateInput,
): Promise<{ node_id: string } | null> {
  const birth = await findExistingRateEvent(tx, input.proposalId);
  if (birth?.decision !== 'accept') return null;

  const mintedIds = (birth.payload as { materialized_ids?: { knowledge?: unknown } })
    .materialized_ids?.knowledge;
  const nodeId = Array.isArray(mintedIds) && typeof mintedIds[0] === 'string' ? mintedIds[0] : null;
  if (!nodeId) return null;

  const node = (
    await tx
      .select({ id: knowledge.id, version: knowledge.version })
      .from(knowledge)
      .where(and(eq(knowledge.id, nodeId), isNull(knowledge.archived_at)))
      .limit(1)
  )[0];
  if (!node) return null;

  const correctionEventId = input.correction_event_id;
  if (!correctionEventId) {
    throw new Error('knowledge retraction requires the correction event id');
  }

  const archiveEventId = newId();
  const now = new Date();
  const retiredEdges = await prepareKnowledgeArchive(
    tx,
    { mutation: 'archive', node_id: nodeId, expected_version: node.version },
    now,
  );
  await requireRetiredEdgeFacts(tx, nodeId, retiredEdges);

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
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: archiveEventId,
    outcome: 'success',
    payload: {
      rating: 'accept',
      knowledge_operation: {
        version: 1,
        kind: 'archive',
        retracts_accept_event_id: birth.id,
        correction_event_id: correctionEventId,
        targets: [
          {
            kind: 'knowledge',
            id: nodeId,
            effect: 'archive',
            before_version: node.version,
            after_version: node.version + 1,
            fact_event_id: archiveEventId,
          },
          ...retiredEdges.map((edge) => ({
            kind: 'knowledge_edge',
            id: edge.edge_id,
            effect: 'archive',
            fact_event_id: edge.event_id,
          })),
        ],
      },
    },
    caused_by_event_id: archiveEventId,
    created_at: now,
  });
  await projectKnowledgeNodeGuarded(tx, nodeId);
  return { node_id: nodeId };
}
