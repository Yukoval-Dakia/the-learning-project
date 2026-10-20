// YUK-1571 — narrow knowledge-graph input reads for the kernel hub-mesh
// curation algorithm (@/kernel/hub-mesh). The notes hub-sync reconciler is the
// only production consumer; it previously loaded these through
// knowledge/public (`loadTreeSnapshot` + `listKnowledgeEdges`). Each read
// mirrors the exact semantics that consumer relied on — the narrowing is the
// SELECTED COLUMN SET ONLY (the algorithm reads just id/parent_id and the edge
// endpoint triple), never the row set, ordering, caps, or filtering.
//
// Deliberately NOT carried over (unused by the consumer, different dependency
// lanes): the mastery overlay (`getMasteryProjection` → mastery_state + the
// per-KC β lookup), the knowledge_mastery join (it only fed `last_active_at`),
// the effective_domain parent-chain walk, and the optional subject filter
// (hub-sync never passes a subject). The view join is exactly 1:1 per
// knowledge.id — `agg` and `activity` are both GROUP BY knowledge_id — so
// dropping it preserves row cardinality and the `ORDER BY id` sequence; the
// overlay/last_active_at removal strictly shrinks the failure surface (fewer
// SELECTs, no new error type) and is identical under every healthy DB state.

import { desc, isNull } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';

/**
 * Short-term OOM guard mirroring `LOAD_TREE_SNAPSHOT_LIMIT` in
 * src/capabilities/knowledge/server/tree.ts (YUK-236 [STB-2]) — same 5000 cap,
 * same phase-deferred CTE follow-up applies here.
 */
export const KNOWLEDGE_BACKBONE_NODE_LIMIT = 5000;

/** The backbone fields the hub-mesh curation reads (`treeDescendantIds`). */
export interface KnowledgeBackboneNode {
  id: string;
  parent_id: string | null;
}

/**
 * Emit the same structured warn as `warnIfTreeSnapshotTruncated` when a backbone
 * snapshot hits the {@link KNOWLEDGE_BACKBONE_NODE_LIMIT} cap — identical
 * message + context so log pipelines and alerts keyed on
 * `tree_snapshot_truncated` keep matching. Pure + injectable `warn`.
 */
export function warnIfBackboneSnapshotTruncated(
  rowCount: number,
  warn: (message: string, context: Record<string, unknown>) => void = console.warn,
): boolean {
  if (rowCount < KNOWLEDGE_BACKBONE_NODE_LIMIT) return false;
  warn('[knowledge_tree] loadTreeSnapshot hit row cap — snapshot likely truncated', {
    event: 'tree_snapshot_truncated',
    limit: KNOWLEDGE_BACKBONE_NODE_LIMIT,
    row_count: rowCount,
  });
  return true;
}

/**
 * The non-archived knowledge backbone for hub-mesh curation.
 *
 * Row set + ordering mirror `loadTreeSnapshot(db)` (no subject): `archived_at
 * IS NULL`, synthetic:* rows INCLUDED, deterministic `ORDER BY id` BEFORE the
 * cap, `LIMIT 5000`, and the truncation warn. The returned columns are the
 * subset the algorithm consumes; the dropped columns (name, domain,
 * last_active_at, mastery overlay, effective_domain) do not reach the consumer.
 */
export async function loadKnowledgeBackboneNodes(db: Db): Promise<KnowledgeBackboneNode[]> {
  const rows = await db
    .select({ id: knowledge.id, parent_id: knowledge.parent_id })
    .from(knowledge)
    .where(isNull(knowledge.archived_at))
    .orderBy(knowledge.id)
    .limit(KNOWLEDGE_BACKBONE_NODE_LIMIT);
  warnIfBackboneSnapshotTruncated(rows.length);
  return rows;
}

/** The live-edge endpoint triple the hub-mesh curation reads. */
export interface KnowledgeMeshEdge {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}

const LIST_MESH_EDGES_LIMIT = 500;

/**
 * The live (non-archived) knowledge_edge mesh for hub-mesh curation, mirroring
 * the default `listKnowledgeEdges(db)` path in
 * src/capabilities/knowledge/server/edges.ts: no subject/from/to/relation
 * filter, `archived_at IS NULL`, `ORDER BY created_at DESC, id DESC`, capped at
 * 500 rows. The source path fetched 501 to compute `next_cursor`; the extra row
 * only fed pagination the consumer discarded, so `LIMIT 500` returns the same
 * row set. KNOWN PRE-EXISTING TRUNCATION, preserved deliberately: beyond 500
 * live edges the curation sees only the newest 500 — lifting the cap is a
 * separate product decision, not this move's scope.
 */
export async function listKnowledgeMeshEdges(db: Db | Tx): Promise<KnowledgeMeshEdge[]> {
  return await db
    .select({
      from_knowledge_id: knowledge_edge.from_knowledge_id,
      to_knowledge_id: knowledge_edge.to_knowledge_id,
      relation_type: knowledge_edge.relation_type,
    })
    .from(knowledge_edge)
    .where(isNull(knowledge_edge.archived_at))
    .orderBy(desc(knowledge_edge.created_at), desc(knowledge_edge.id))
    .limit(LIST_MESH_EDGES_LIMIT);
}
