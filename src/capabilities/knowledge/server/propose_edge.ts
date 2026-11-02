// Knowledge-edge supersede apply for the accept path.
// The nightly edge proposer was folded into knowledge maintenance (YUK-1664);
// agents now propose edges through the shared propose_knowledge_edge tool. Pending
// supersede proposals written by the old proposer still apply here on accept.

import { createId } from '@paralleldrive/cuid2';
import type { EdgeProposalSchemaT } from '@/capabilities/knowledge/tasks/knowledge-tasks';
import type { ActivityRefT } from '@/core/schema/activity';
import type { Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import {
  type EdgeReconcileDecision,
  insertEdgePlannedRows,
  makeEdgePlannedRow,
  markEdgeReconcileApplied,
} from './edge-reconcile-store';
import { archiveKnowledgeEdgeFromEvents, createKnowledgeEdge } from './edges';

/**
 * Apply a user-approved supersede inside the caller's transaction: record plan,
 * archive old, create replacement + generate event, write correction, mark applied.
 * The log is audit/provenance, not a replay cursor; double-apply is prevented by
 * the unique edge key and upstream dedup, not deterministic ids.
 */
export async function applyApprovedEdgeSupersede(
  db: Tx,
  opts: {
    candidate: EdgeProposalSchemaT;
    supersededEdgeId: string;
    decision: EdgeReconcileDecision;
    affectedRefs: ActivityRefT[];
    proposeEventId: string;
  },
): Promise<{ edgeId: string; generateEventId: string }> {
  const { candidate: p, supersededEdgeId, decision, affectedRefs, proposeEventId } = opts;
  const now = new Date();

  const logRow = makeEdgePlannedRow({
    candidate_from_knowledge_id: p.from_knowledge_id,
    candidate_to_knowledge_id: p.to_knowledge_id,
    candidate_relation_type: p.relation_type,
    action: 'SUPERSEDE',
    superseded_edge_id: supersededEdgeId,
    confidence: decision.confidence,
    reason: decision.reason,
    llm_raw: { action: decision.action, neighbor_index: decision.neighbor_index },
  });

  const newGenerateEventId = createId();
  const oldArchiveGenerateEventId = createId();
  const correctionEventId = createId();
  await insertEdgePlannedRows(db, [logRow]);

  const archived = await archiveKnowledgeEdgeFromEvents(db, supersededEdgeId, {
    event_id: oldArchiveGenerateEventId,
    caused_by_event_id: proposeEventId,
    created_at: now,
    reasoning: `reconcile SUPERSEDE: ${decision.reason}`,
  });
  if (!archived.archived)
    throw new Error(`superseded edge ${supersededEdgeId} is already archived`);

  const newEdgeId = await createKnowledgeEdge(db, {
    generate_event_id: newGenerateEventId,
    from_knowledge_id: p.from_knowledge_id,
    to_knowledge_id: p.to_knowledge_id,
    relation_type: p.relation_type,
    weight: p.weight,
    reasoning: p.reasoning,
    actor_kind: 'user',
    actor_ref: 'self',
    propose_event_id: proposeEventId,
    created_at: now,
  });

  await writeEvent(db, {
    id: correctionEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: oldArchiveGenerateEventId,
    outcome: 'success',
    payload: {
      correction_kind: 'supersede',
      replacement_event_id: newGenerateEventId,
      reason_md: `user accepted reconcile supersede: ${decision.reason}`,
      affected_refs: affectedRefs,
    },
    caused_by_event_id: oldArchiveGenerateEventId,
    created_at: now,
  });

  await markEdgeReconcileApplied(db, logRow.id);

  return { edgeId: newEdgeId, generateEventId: newGenerateEventId };
}
