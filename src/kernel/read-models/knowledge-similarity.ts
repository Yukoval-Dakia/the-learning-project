// KC-keyed cosine retrieval for match-or-propose tagging.
// Archived, unembedded, non-kc, and stale-vector rows are not candidates.
// The retriever is global; the tagger applies the subject filter and threshold.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { getConfig } from '@/core/config/store';
import type { Db } from '@/db/client';
import { embedCurrencyPredicate } from '@/db/embed-currency';
import { knowledge } from '@/db/schema';
import { toSqlVector } from '@/db/vector';

/**
 * Cosine distance ceiling for a match. The query embeds the full question while KCs
 * embed name and domain, so distances run higher than a symmetric compare; the quiz
 * matcher's 0.35 was too tight here and matched nothing in the probe. 0.55 sits inside
 * the correct band but is still untuned on a real corpus. Too tight creates duplicates
 * (dedup catches them); too loose is a wrong match, which is rarer.
 */
const DEFAULT_MATCH_THRESHOLD = 0.55;

export function matchThreshold(): number {
  const v = getConfig('TAGGING_MATCH_THRESHOLD');
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_MATCH_THRESHOLD;
}

/**
 * Global retrieval window before the subject filter runs, so an in-domain KC ranked
 * past it is invisible. Shared with the calibration replay.
 */
export const RETRIEVAL_TOP_K = 10;

export interface KnowledgeSimilarityCandidate {
  knowledge_id: string;
  name: string;
  /** Only subject roots carry it; projected so the caller can resolve effective domain. */
  domain: string | null;
  parent_id: string | null;
  /** Row revision at retrieval time. */
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

  const limit = Math.max(1, Math.trunc(opts.topK));
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
      // A pending KC stays matchable so a similar question reuses it instead of
      // minting a duplicate. Gating on approved would change that review flow.
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
