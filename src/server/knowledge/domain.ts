import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { eq } from 'drizzle-orm';

const MAX_DEPTH = 32; // 防 cycle

/**
 * Walk up parent chain to find first non-null domain.
 * Invariant: parent_id IS NULL ↔ domain IS NOT NULL（root 必有 domain）。
 *
 * GET /api/knowledge does its own in-memory walk over the full tree (batch-friendly),
 * so this single-node helper is reserved for Sub 2's KnowledgeProposeTask which will
 * need point lookups during tool calling (resolving a node's domain in tool results).
 */
export async function getEffectiveDomain(db: Db, nodeId: string): Promise<string> {
  let curId: string = nodeId;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const row = (
      await db
        .select({ domain: knowledge.domain, parent_id: knowledge.parent_id })
        .from(knowledge)
        .where(eq(knowledge.id, curId))
        .limit(1)
    )[0];
    if (!row) {
      throw new Error(`knowledge node not found: ${curId}`);
    }
    if (row.domain !== null) {
      return row.domain;
    }
    if (row.parent_id === null) {
      throw new Error(`root node has null domain (invariant violation): ${curId}`);
    }
    curId = row.parent_id;
  }
  throw new Error(`getEffectiveDomain max depth ${MAX_DEPTH} exceeded for ${nodeId}`);
}
