// KC-keyed cosine retriever over `knowledge.embedding`, used by match-or-propose
// tagging.
//
// `<=>` is pgvector cosine distance (0 nearest, 2 farthest). Archived and unembedded
// rows are excluded. This is a pure global top-K read: effective domain is derived in
// the app, so the caller applies both the threshold and the subject filter.
//
// YUK-1604 — only role='kc' nodes are match candidates: a goal/container node must
// never be attributed to a question as its knowledge point (拍卷不把目标节点当知识点).
// Legacy rows carry the column default 'kc', so nothing that matches today is lost.
//
// YUK-1603 — only vectors current for the row revision are candidates (shared
// embed-currency predicate): a vector stamped behind the node's version is not a
// current result. Candidates carry the version provenance so the caller's audit
// trail can reconcile which revision produced each match.

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { embedCurrencyPredicate } from '@/db/embed-currency';
import { knowledge } from '@/db/schema';
import { toSqlVector } from '@/db/vector';

export interface KnowledgeSimilarityCandidate {
  knowledge_id: string;
  name: string;
  /** Only subject roots carry it; projected so the caller can resolve effective domain. */
  domain: string | null;
  parent_id: string | null;
  /** Row revision at retrieval time (YUK-1603 reconciliation provenance). */
  version: number;
  /** Row revision the stored vector was computed from; NULL = pre-column legacy. */
  embed_source_revision: number | null;
  /** sha256 of the embed-source text the vector was stamped from. */
  embed_content_hash: string | null;
  /** pgvector cosine distance to the query vector: 0 (nearest) .. 2 (farthest). */
  cosine_distance: number;
}

export interface MatchKnowledgeOptions {
  /** Max candidates returned, nearest-first. */
  topK: number;
}

/**
 * Nearest embedded KCs, nearest first. An empty query vector returns [] so the caller
 * proposes instead. A wrong vector length fails loudly at query time by contract.
 */
export async function matchKnowledgeBySimilarity(
  db: Db,
  queryEmbedding: number[],
  opts: MatchKnowledgeOptions,
): Promise<KnowledgeSimilarityCandidate[]> {
  if (queryEmbedding.length === 0) return [];

  // Clamp to at least one, so a bad topK cannot silently route everything to propose.
  const limit = Math.max(1, Math.trunc(opts.topK));

  // One expression for both projection and ordering, so the thresholded value is the
  // sorted value.
  const distanceExpr = sql<number>`${knowledge.embedding} <=> ${toSqlVector(queryEmbedding)}::vector`;

  return (
    db
      .select({
        knowledge_id: knowledge.id,
        name: knowledge.name,
        domain: knowledge.domain,
        parent_id: knowledge.parent_id,
        version: knowledge.version,
        embed_source_revision: knowledge.embed_source_revision,
        embed_content_hash: knowledge.embed_content_hash,
        cosine_distance: distanceExpr,
      })
      .from(knowledge)
      // approval_status is intentionally not filtered: a pending KC stays matchable so a
      // similar question reuses it instead of minting a duplicate. Gating on approved
      // would be a semantics change for the review flow to decide.
      .where(
        and(
          isNull(knowledge.archived_at),
          eq(knowledge.role, 'kc'),
          sql`${knowledge.embedding} IS NOT NULL`,
          embedCurrencyPredicate(knowledge),
        ),
      )
      .orderBy(distanceExpr)
      .limit(limit)
  );
}
