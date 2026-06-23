// YUK-471 W1 PR-A2a — full projection rebuild: re-fold EVERY knowledge / knowledge_edge id
// from the event log via the IO shells.
//
// WHY. The IO shells (projectKnowledgeNode / projectKnowledgeEdge) are the SoT-write
// primitive PR-B's accept path flips to. This script reuses them 1:1 to do a FULL rebuild:
// for every node id (then every edge id) it calls the shell, which re-derives the row from
// the event log and writes it through (upsert) — or DELETEs it if the fold resolves to null.
// Reusing the per-id shell keeps the rebuild path BYTE-IDENTICAL to the live SoT path (a
// deliberate single-implementation invariant: PR-B's accept calls the same shell, so the
// audit (audit:projection) verifying the live path also verifies the rebuild path).
//
// "TRUNCATE-and-refold" semantics WITHOUT a literal TRUNCATE: the shell already does
// upsert-or-DELETE per id, so re-projecting every id rebuilds the table in place — a row
// whose events resolve to null is DELETEd, every other row is overwritten with the folded
// state. We REBUILD IN PLACE (no shadow table). The owner runs this against a PROD-CLONE for
// PR-B's B3 gate (rebuild, then audit:projection must report CLEAN), not against live prod.
//
// ID UNIVERSE. We project the UNION of (a) live `knowledge` / `knowledge_edge` ids and (b)
// ids anchored in materialized_id_index (a propose_new/split-born node whose live row was
// dropped still has an anchor — projecting it lets the shell DELETE/re-create it correctly).
// Edges are keyed only on subject_id (no reverse index), so their universe is the live edge
// ids plus any edge subject_ids in the event log.
//
// ORDER. knowledge BEFORE knowledge_edge (FK: edges reference knowledge.id). The whole
// rebuild runs in ONE transaction so a topology reject (foldKnowledgeEdge throws) rolls the
// entire rebuild back rather than leaving a half-rebuilt mesh.
//
// BEHAVIOR-PRESERVING (PR-A2a): a standalone operational script; NOT wired into any request
// path. It is the engine audit:projection's future full-rebuild mode can reuse.
//
// CLI:
//   pnpm rebuild:projection   # re-fold every node then every edge, in one tx, in place

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { type Db, type Tx, db } from '@/db/client';
import { event, knowledge, knowledge_edge, materialized_id_index } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { projectKnowledgeNode } from '../src/server/projections/knowledge';
import { projectKnowledgeEdge } from '../src/server/projections/knowledge_edge';

type DbLike = Db | Tx;

export interface RebuildCounts {
  nodes: number;
  edges: number;
}

// Collect the full id universe to re-project for nodes: live knowledge ids ∪ index-anchored
// 'knowledge' ids. (Edges are gathered separately — they have no reverse index.)
async function allNodeIds(db: DbLike): Promise<string[]> {
  const live = await db.select({ id: knowledge.id }).from(knowledge);
  const anchored = await db
    .select({ id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(eq(materialized_id_index.subject_kind, 'knowledge'));
  return [...new Set([...live.map((r) => r.id), ...anchored.map((r) => r.id)])];
}

// Edge id universe: live knowledge_edge ids ∪ every edge subject_id seen in the event log
// (an edge whose live row was archived/dropped still has events keyed on its id).
async function allEdgeIds(db: DbLike): Promise<string[]> {
  const live = await db.select({ id: knowledge_edge.id }).from(knowledge_edge);
  const fromEvents = await db
    .select({ id: event.subject_id })
    .from(event)
    .where(eq(event.subject_kind, 'knowledge_edge'));
  return [...new Set([...live.map((r) => r.id), ...fromEvents.map((r) => r.id)])];
}

/**
 * Re-fold every node then every edge through the IO shells, in one transaction (knowledge
 * first — FK). Returns the count of ids projected. Throws (rolling the whole tx back) if any
 * edge projection hits an ADR-0034 topology reject.
 *
 * Takes a DbLike so the DB test can drive it inside the testcontainer; the CLI passes the
 * process `db` and wraps the whole rebuild in a transaction.
 */
export async function rebuildProjection(db: DbLike): Promise<RebuildCounts> {
  const nodeIds = await allNodeIds(db);
  for (const id of nodeIds) {
    await projectKnowledgeNode(db, id);
  }
  const edgeIds = await allEdgeIds(db);
  for (const id of edgeIds) {
    await projectKnowledgeEdge(db, id);
  }
  return { nodes: nodeIds.length, edges: edgeIds.length };
}

async function main(): Promise<void> {
  // ONE transaction: a topology reject mid-rebuild aborts the whole thing rather than leaving
  // a half-rebuilt mesh.
  const counts = await db.transaction((tx) => rebuildProjection(tx));
  console.log(
    `[rebuild-projection] done — re-folded ${counts.nodes} node(s) + ${counts.edges} edge(s) in place.`,
  );
}

// CLI-gate: only run + exit as the CLI entry point so the DB test can import rebuildProjection
// without the top-level run firing.
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('rebuild-projection.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[rebuild-projection] failed:', err);
      process.exit(1);
    });
}
