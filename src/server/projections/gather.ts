// YUK-471 W1 PR-A2a — read-only gather+fold helpers shared by the IO shells and the
// projection auditor.
//
// The IO shells (knowledge.ts / knowledge_edge.ts) and the projection auditor
// (scripts/audit-projection.ts) both need the SAME read→fold step: gather the superset of
// `event` rows that can affect a node/edge id, map each → FoldEvent, and run the PURE
// reducer. The only difference is what they do with the result — the shell WRITES it through
// (insert/onConflictDoUpdate or DELETE); the auditor DEEP-DIFFS it against the live row in
// memory and writes NOTHING. Factoring the read→fold half out keeps a SINGLE gather
// implementation, so the SoT path (shell) and the drift auditor can never silently diverge
// in HOW they reconstruct a row (a divergence would make the audit blind to exactly the
// gather bugs it exists to catch).
//
// These functions are READ-ONLY: they SELECT from `event` / `knowledge_edge` /
// `materialized_id_index` and return the projected snapshot (or null). They never write.
//
// BEHAVIOR-PRESERVING (PR-A2a): added + used by the (un-wired) shells + the standalone
// auditor only; no live write path imports them.

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { FoldEvent } from '@/core/projections/fold-event';
import { foldKnowledgeNode } from '@/core/projections/knowledge';
import { foldKnowledgeEdge } from '@/core/projections/knowledge_edge';
import type { KnowledgeEdgeRowSnapshotT, KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import { getAnchorEventId } from './materialized-id-index';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;
type EdgeRow = typeof knowledge_edge.$inferSelect;

// rowToFoldEvent — map ONE `event` DB row to the flat FoldEvent envelope the reducers
// consume. payload is jsonb; outcome / caused_by_event_id may be null. (Shared by both
// node + edge gathers; identical to the per-shell mapper they previously each declared.)
export function rowToFoldEvent(row: EventRow): FoldEvent {
  return {
    id: row.id,
    created_at: row.created_at,
    actor_kind: row.actor_kind,
    actor_ref: row.actor_ref,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    outcome: row.outcome ?? null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    caused_by_event_id: row.caused_by_event_id ?? null,
  };
}

// edgeRowToSnapshot — map a live `knowledge_edge` DB row to the KnowledgeEdgeRowSnapshotT
// shape the edge reducer's liveMesh (topology fixture) expects.
function edgeRowToSnapshot(row: EdgeRow): KnowledgeEdgeRowSnapshotT {
  return {
    id: row.id,
    from_knowledge_id: row.from_knowledge_id,
    to_knowledge_id: row.to_knowledge_id,
    relation_type: row.relation_type,
    weight: row.weight,
    created_by: row.created_by as Record<string, unknown>,
    reasoning: row.reasoning ?? null,
    created_at: row.created_at,
    archived_at: row.archived_at ?? null,
  };
}

/**
 * Gather the superset of events affecting `nodeId` and run the PURE node fold. READ-ONLY.
 *
 * The gather is the keystone of the node projection (see the long rationale on the node
 * shell): Q1 (subject-keyed) + Q2 (reverse-index anchor for propose_new / split CREATE) +
 * Q3 (nodeId merged INTO another node) + the chained accept rates. Returns the projected
 * row or null (node never created / fully reverted). Writes NOTHING — the caller decides
 * (shell write-through vs auditor diff).
 */
export async function gatherAndFoldKnowledgeNode(
  db: DbLike,
  nodeId: string,
): Promise<KnowledgeRowSnapshotT | null> {
  // ── Q1: events whose subject_id IS nodeId ──────────────────────────────────────────
  // Covers genesis, auto_tag, reparent, archive, merge-as-into, split-as-from.
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'knowledge'), eq(event.subject_id, nodeId)));

  // ── Q2: reverse-index anchor (propose_new / split CREATE) ───────────────────────────
  // For a node born via propose_new / split, no event has subject_id === nodeId. The anchor
  // is the propose/split event the accept materialized this id from; pull the anchor PLUS
  // everything caused_by it (the anchor's accepting rate carries materialized_ids).
  const anchorId = await getAnchorEventId(db, nodeId);
  const q2: EventRow[] = anchorId
    ? await db
        .select()
        .from(event)
        .where(or(eq(event.id, anchorId), eq(event.caused_by_event_id, anchorId)))
    : [];

  // ── Q3: nodeId archived because it was merged INTO another node ──────────────────────
  // The merge event's subject_id is the into_id, NOT nodeId; nodeId lives only in
  // payload.from_ids. jsonb containment: payload -> 'from_ids' @> [nodeId].
  const q3 = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:knowledge_merge'),
        sql`${event.payload} -> 'from_ids' @> ${JSON.stringify([nodeId])}::jsonb`,
      ),
    );

  // Dedup the propose/mutation/genesis rows by event id (Q1/Q2/Q3 overlap).
  const byId = new Map<string, EventRow>();
  for (const r of [...q1, ...q2, ...q3]) byId.set(r.id, r);

  // ── Rate resolution ─────────────────────────────────────────────────────────────────
  // The reducer needs the RATE events chained to the gathered propose/mutation events.
  const gatheredIds = [...byId.keys()];
  if (gatheredIds.length > 0) {
    const rates = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, gatheredIds)));
    for (const r of rates) byId.set(r.id, r);
  }

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldKnowledgeNode(nodeId, foldEvents);
}

/**
 * Gather all events for `edgeId` + the live topology mesh, then run the PURE edge fold.
 * READ-ONLY.
 *
 * Edges are simple — every edge event keys on the edge's own subject_id, so the gather is a
 * single subject-keyed query. The reducer re-checks ADR-0034 topology for a create that adds
 * a LIVE prerequisite edge, against `liveMesh` (the current archived_at IS NULL edge set).
 *
 * @throws when foldKnowledgeEdge rejects on ADR-0034 topology — NOT caught (propagates so the
 *         caller decides; the shell lets it abort the accept tx, the auditor surfaces it).
 */
export async function gatherAndFoldKnowledgeEdge(
  db: DbLike,
  edgeId: string,
): Promise<KnowledgeEdgeRowSnapshotT | null> {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'knowledge_edge'), eq(event.subject_id, edgeId)));
  const foldEvents = rows.map(rowToFoldEvent);

  // liveMesh is the full live-edge set and INCLUDES the edge being re-projected
  // (self-inclusion). This is intentional-and-benign for re-projection: checkEdgeTopology
  // short-circuits a candidate that already exists in `existing` (③ cycle finds no new
  // reverse path from a self-edge; ④ transitive-redundancy is skipped because the edge
  // is alreadyDirect). If a future topology check stops tolerating the candidate appearing
  // in `existing`, exclude this edgeId from liveMesh here.
  const liveRows = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
  const liveMesh = liveRows.map(edgeRowToSnapshot);

  return foldKnowledgeEdge(edgeId, foldEvents, liveMesh);
}
