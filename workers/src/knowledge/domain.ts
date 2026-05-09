import type { D1Database } from '@cloudflare/workers-types';

interface KnowledgeRow {
  domain: string | null;
  parent_id: string | null;
}

const MAX_DEPTH = 32; // 防 cycle

/**
 * Walk up parent chain to find first non-null domain.
 * Invariant: parent_id IS NULL ↔ domain IS NOT NULL（root 必有 domain）。
 */
export async function getEffectiveDomain(db: D1Database, nodeId: string): Promise<string> {
  let curId: string = nodeId;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const row = await db
      .prepare('select domain, parent_id from knowledge where id = ?')
      .bind(curId)
      .first<KnowledgeRow>();
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
