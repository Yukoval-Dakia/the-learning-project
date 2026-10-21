// Complete knowledge-graph reads for notes hub curation and existing consumers.
// loadTreeSnapshot preserves the original tree read: knowledge_mastery join, mastery
// overlay, effective-domain walk, optional subject filter, 5000-row cap with a
// truncation warn. listKnowledgeMeshEdges preserves the default listKnowledgeEdges
// row set, ordering, 500-edge truncation, and cursor encoding.

import { desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge, knowledge_edge, knowledge_mastery } from '@/db/schema';
import { matchesSubjectDomain } from '@/kernel/read-models/knowledge-tree';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';
import { normalizeSubjectKey, resolveKnownSubjectId } from '@/subjects/profile';

interface KnowledgeRow {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: Date | null;
  mastery: number | null;
  // ADR-0035 confidence band. Absent when never attempted, so the client shows the
  // unknown band.
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
  last_evidence_at: Date | null;
  last_active_at: Date;
}

export interface KnowledgeNode extends KnowledgeRow {
  effective_domain: string | null;
}

/**
 * OOM guard: loadTreeSnapshot materializes the whole active graph. 5000 is far above
 * single-user size. The truncation warn fires when this is outgrown.
 */
export const LOAD_TREE_SNAPSHOT_LIMIT = 5000;

/**
 * Structured warn when a snapshot hit the cap, since effective-domain and
 * parent-chain inheritance may be silently incomplete.
 */
export function warnIfTreeSnapshotTruncated(
  rowCount: number,
  warn: (message: string, context: Record<string, unknown>) => void = console.warn,
): boolean {
  if (rowCount < LOAD_TREE_SNAPSHOT_LIMIT) return false;
  warn('[knowledge_tree] loadTreeSnapshot hit row cap — snapshot likely truncated', {
    event: 'tree_snapshot_truncated',
    limit: LOAD_TREE_SNAPSHOT_LIMIT,
    row_count: rowCount,
  });
  return true;
}

export async function loadTreeSnapshot(db: Db, subject?: string): Promise<KnowledgeNode[]> {
  // Mastery comes from the mastery_state projection, not the deprecated
  // knowledge_mastery success-rate view. last_active_at is an orthogonal any-event
  // timeline, so it still reads the view.
  const baseRows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
      last_active_at: sql<Date>`COALESCE(${knowledge_mastery.last_active_at}, ${knowledge.created_at})`,
    })
    .from(knowledge)
    .leftJoin(knowledge_mastery, eq(knowledge_mastery.knowledge_id, knowledge.id))
    .where(isNull(knowledge.archived_at))
    // Include synthetic:* rows: internal consumers need the seed scaffolding;
    // learner-facing exclusion happens at the API projection boundary.
    // Stable order before the cap so a truncated subset is reproducible and cannot
    // drop a parent and mis-compute a child's effective domain.
    .orderBy(knowledge.id)
    .limit(LOAD_TREE_SNAPSHOT_LIMIT);
  warnIfTreeSnapshotTruncated(baseRows.length);

  // Absent nodes -> mastery null / evidence 0 / no last_evidence_at.
  const projection = await getMasteryProjection(
    db,
    baseRows.map((r) => r.id),
  );
  const rows: KnowledgeRow[] = baseRows.map((r) => {
    const proj = projection.get(r.id);
    return {
      id: r.id,
      name: r.name,
      domain: r.domain,
      parent_id: r.parent_id,
      archived_at: r.archived_at,
      mastery: proj ? proj.mastery : null,
      // Band fields from the same projection; absent -> null/false, rendered as
      // the unknown band.
      mastery_lo: proj?.mastery_lo ?? null,
      mastery_hi: proj?.mastery_hi ?? null,
      low_confidence: proj?.low_confidence ?? false,
      evidence_count: proj?.evidence_count ?? 0,
      last_evidence_at: proj?.last_outcome_at ?? null,
      last_active_at: r.last_active_at,
    };
  });

  const byId = new Map<string, KnowledgeRow>();
  for (const r of rows) byId.set(r.id, r);
  const snapshot = rows.map((r) => {
    let cur: KnowledgeRow | undefined = r;
    let depth = 0;
    while (depth < 32 && cur && cur.domain === null && cur.parent_id !== null) {
      const next = byId.get(cur.parent_id);
      if (next === undefined) break;
      cur = next;
      depth++;
    }
    return { ...r, effective_domain: cur?.domain ?? null };
  });
  if (!subject) return snapshot;

  const canonical = resolveKnownSubjectId(subject);
  const rawKey = normalizeSubjectKey(subject);
  const syntheticRootId = `seed:${canonical ?? rawKey}:root`;
  return snapshot.filter((row) => {
    if (row.id === syntheticRootId) return true;
    return matchesSubjectDomain(subject, row.effective_domain);
  });
}

/** The live-edge endpoint triple the hub-mesh curation reads. */
export interface KnowledgeMeshEdge {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}

const LIST_MESH_EDGES_LIMIT = 500;

/**
 * Live knowledge_edge mesh with the default listKnowledgeEdges ordering and row set.
 * Fetch LIMIT+1, keep 500, and encode the discarded cursor to preserve its timestamp
 * failure behavior. Truncation beyond 500 is pre-existing and intentional.
 */
export async function listKnowledgeMeshEdges(db: Db | Tx): Promise<KnowledgeMeshEdge[]> {
  const fetched = await db
    .select()
    .from(knowledge_edge)
    .where(isNull(knowledge_edge.archived_at))
    .orderBy(desc(knowledge_edge.created_at), desc(knowledge_edge.id))
    .limit(LIST_MESH_EDGES_LIMIT + 1);
  const hasMore = fetched.length > LIST_MESH_EDGES_LIMIT;
  const rows = hasMore ? fetched.slice(0, LIST_MESH_EDGES_LIMIT) : fetched;
  const result = rows.map((row) => ({
    from_knowledge_id: row.from_knowledge_id,
    to_knowledge_id: row.to_knowledge_id,
    relation_type: row.relation_type,
  }));
  const last = rows.at(-1);
  if (hasMore && last) {
    // Encode even though unused, preserving the timestamp failure behavior.
    Buffer.from(
      JSON.stringify({ created_at: last.created_at.toISOString(), id: last.id }),
    ).toString('base64url');
  }
  return result;
}
