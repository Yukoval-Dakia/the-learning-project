// YUK-674 — report-only inventory of live prerequisite mesh edges that duplicate
// a direct knowledge.parent_id relationship. This script never mutates data;
// remediation remains an explicit owner decision.

import './load-env';

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db, Tx } from '@/db/client';
import { sql } from 'drizzle-orm';

type DbLike = Db | Tx;

export interface TreeMeshOverlapRow {
  [key: string]: unknown;
  edge_id: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  tree_child_id: string;
  tree_parent_id: string;
}

export async function findTreeMeshOverlaps(db: DbLike): Promise<TreeMeshOverlapRow[]> {
  const rows = await db.execute<TreeMeshOverlapRow>(sql`
    SELECT
      edge.id AS edge_id,
      edge.from_knowledge_id,
      edge.to_knowledge_id,
      CASE
        WHEN from_node.parent_id = to_node.id THEN from_node.id
        ELSE to_node.id
      END AS tree_child_id,
      CASE
        WHEN from_node.parent_id = to_node.id THEN to_node.id
        ELSE from_node.id
      END AS tree_parent_id
    FROM knowledge_edge AS edge
    INNER JOIN knowledge AS from_node ON from_node.id = edge.from_knowledge_id
    INNER JOIN knowledge AS to_node ON to_node.id = edge.to_knowledge_id
    WHERE edge.archived_at IS NULL
      AND edge.relation_type = 'prerequisite'
      AND (
        from_node.parent_id = to_node.id
        OR to_node.parent_id = from_node.id
      )
    ORDER BY edge.created_at ASC, edge.id ASC
  `);
  return [...rows];
}

async function main(): Promise<void> {
  const { db } = await import('@/db/client');
  try {
    const overlaps = await findTreeMeshOverlaps(db);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ count: overlaps.length, overlaps }, null, 2));
    } else {
      console.log(`tree/mesh prerequisite overlaps: ${overlaps.length}`);
      for (const row of overlaps) {
        console.log(
          `- edge ${row.edge_id}: ${row.from_knowledge_id} → ${row.to_knowledge_id} ` +
            `(tree ${row.tree_child_id} → parent ${row.tree_parent_id})`,
        );
      }
      if (overlaps.length > 0) {
        console.log('Report only: review these rows before any archive or data repair.');
      }
    }
    process.exitCode = overlaps.length === 0 ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`audit:tree-mesh failed (operational error): ${message}`);
    process.exitCode = 2;
  } finally {
    try {
      await db.$client.end({ timeout: 5 });
    } catch {
      // The pool may already be closed after an operational failure.
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
