// Strict pre-mutation knowledge history authority. Caller holds the node row lock;
// structural materialization uses the shared kernel history without owning this guard.

import { diffSnapshots } from '@/core/projections/snapshot-diff';
import type { Db, Tx } from '@/db/client';
import type { knowledge } from '@/db/schema';
import {
  gatherAndFoldKnowledgeNode,
  knowledgeLiveRowToSnapshot,
} from '@/kernel/records/knowledge-node-history';

type DbLike = Db | Tx;

/** Strict pre-mutation guard. Caller must hold the node row lock; derived embedding is excluded. */
export async function requireKnowledgeHistory(
  db: DbLike,
  node: typeof knowledge.$inferSelect,
): Promise<void> {
  const folded = await gatherAndFoldKnowledgeNode(db, node.id);
  if (!folded) throw new Error(`knowledge ${node.id} requires complete history before mutation`);
  if (diffSnapshots(knowledgeLiveRowToSnapshot(node), folded).length > 0) {
    throw new Error(`knowledge ${node.id} has fold/live drift; repair history before mutation`);
  }
}
