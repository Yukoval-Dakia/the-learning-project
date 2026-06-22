// P1 (YUK-489) — KC-keyed cosine retriever over `knowledge.embedding`. The unified
// match-or-propose TaggingTask (YUK-489) calls this to fetch candidate KCs by embedding
// similarity, then decides MATCH (nearest within MATCH_THRESHOLD) vs PROPOSE (new child KC).
//
// Net-new read consumer: `knowledge.embedding` is populated nightly (embed_backfill,
// DashScope text-embedding-v4, 1024-dim) and re-embedded on reparent/edit, but had ZERO
// `<=>` reader before this — the dead `knowledge_ids:[]` cold-start gate (YUK-478 false
// premise) meant the tagger only ever matched against the in-prompt grid, never the vectors.
//
// Mirrors the `poolFetch` (src/server/quiz/pool-fetch.ts) ORDER-BY-`<=>` pattern, retargeted
// from `question` to `knowledge`. `<=>` is pgvector COSINE DISTANCE (0 = identical direction,
// 1 = orthogonal, 2 = opposite): SMALLER = NEARER. Rows with a NULL embedding (never embedded
// / edit-NULLed, awaiting the nightly backfill) and archived rows are excluded.
//
// SCOPE (deliberately minimal): this is a PURE global top-K retriever. It does NOT
// subject-scope — effective-domain is app-layer-derived (a parent walk), not a SQL column
// (same reason poolFetch omits it). The caller (P2 TaggingTask) applies the MATCH_THRESHOLD
// cutoff and any effective-domain filter on the returned candidates, mirroring how the quiz
// matcher thresholds poolFetch output in TS rather than in SQL.
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { toSqlVector } from '@/db/vector';
import { and, isNull, sql } from 'drizzle-orm';

export interface KnowledgeSimilarityCandidate {
  knowledge_id: string;
  name: string;
  /** knowledge.domain — only the subject-root carries it; children inherit it via the
   *  parent chain (effective-domain), so this is NULL for non-root KCs. Projected so the
   *  caller can effective-domain-filter without a second query. */
  domain: string | null;
  parent_id: string | null;
  /** pgvector cosine distance to the query vector: 0 (nearest) .. 2 (farthest). */
  cosine_distance: number;
}

export interface MatchKnowledgeOptions {
  /** Max candidates returned, nearest-first. */
  topK: number;
}

/**
 * Fetch the top-K active, embedded KCs nearest to `queryEmbedding` by pgvector cosine
 * distance (nearest first). Pure read; no writes. Returns `[]` for an empty query vector
 * (the caller routes that to the PROPOSE path — there is nothing to match against).
 */
export async function matchKnowledgeBySimilarity(
  db: Db,
  queryEmbedding: number[],
  opts: MatchKnowledgeOptions,
): Promise<KnowledgeSimilarityCandidate[]> {
  if (queryEmbedding.length === 0) return [];

  // Single source of truth: the same distance expression feeds both the SELECT projection
  // and the ORDER BY (the column the caller thresholds on IS the column we sort by), exactly
  // as poolFetch reuses its distanceExpr. A bare expression in ORDER BY sorts ASC → nearest
  // first (smaller cosine distance = nearer).
  const distanceExpr = sql<number>`${knowledge.embedding} <=> ${toSqlVector(queryEmbedding)}::vector`;

  return db
    .select({
      knowledge_id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      cosine_distance: distanceExpr,
    })
    .from(knowledge)
    .where(and(isNull(knowledge.archived_at), sql`${knowledge.embedding} IS NOT NULL`))
    .orderBy(distanceExpr)
    .limit(opts.topK);
}
