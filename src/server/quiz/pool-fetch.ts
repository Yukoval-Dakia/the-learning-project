// Phase 1 增量 1 (YUK-396) — unified pool-fetch operator. Generalizes the ad-hoc
// pool query in queryExistingPool (sourcing-sequence.ts) into one operator that
// composes authoritative scalar filters + KC containment (GIN'd knowledge_ids) +
// OPTIONAL pgvector similarity ordering (Phase 0 embedding column). This is the
// retrieval-substrate consumer seam; increment 1 only ADDS the operator + proves
// the hybrid query — it does NOT migrate any live consumer (that's increment 2).
//
// NOT in increment 1: answer_class filtering (gated on YUK-395 answer_class
// freshness — on-write/re-derive — so a reader can't consume stale/NULL classes);
// soft dims (cause/mastery/syllabus, unmaterialized); cross-KC / effective-domain
// (app-layer derived, not a SQL column).
//
// ⚠️ INCREMENT-2 MIGRATION CONTRACT — poolFetch is NOT a drop-in for
// queryExistingPool. The WHERE clause is byte-identical, but poolFetch returns the
// RAW scalar pool ({id, difficulty}) only. queryExistingPool additionally (a)
// filters in-memory by `kindsMatch(r.kind, kind)` (sourcing-sequence.ts) so a node
// full of `reading` rows can't short-circuit a `computation` request (the A2
// regression), (b) ranks by `compareBySourceTierThenWhitelist` (authentic-first,
// off-whitelist demoted), and (c) slices to limit AFTER that sort. A consumer
// migrating onto poolFetch MUST re-apply the kind filter + tier sort + slice on
// top, and project source/metadata, or it will silently change selection.
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { toSqlVector } from '@/db/vector';
import { type SQL, and, asc, isNull, sql } from 'drizzle-orm';

export interface PoolFetchCriteria {
  /** KC containment: question.knowledge_ids @> [knowledgeId] (GIN). */
  knowledgeId: string;
  /** Exclude draft rows (draft_status IS NULL OR <> 'draft'). Default true. */
  activeOnly?: boolean;
  /** difficulty >= n (integer 1-5). null/undefined → no floor. */
  difficultyMin?: number | null;
  /** difficulty <= n. null/undefined → no ceiling. */
  difficultyMax?: number | null;
  /** unit='篇' — only composite parents: parent_question_id IS NULL AND ≥1 child row
   *  references it via parent_question_id (in practice a question_part; the EXISTS
   *  does not constrain child kind, matching queryExistingPool). */
  compositeParentOnly?: boolean;
  /** When non-empty, order by cosine distance to this query vector (hybrid retrieval);
   *  rows with NULL embedding are excluded. Otherwise order by created_at, id. */
  queryEmbedding?: number[] | null;
  /** Max rows. undefined → no limit. */
  limit?: number;
}

export interface PoolRow {
  id: string;
  difficulty: number;
}

/** Fetch a candidate question pool by composite scalar filters + KC containment,
 *  optionally ranked by pgvector similarity. Pure read; no writes. */
export async function poolFetch(db: Db, c: PoolFetchCriteria): Promise<PoolRow[]> {
  const preds: SQL[] = [
    sql`${question.knowledge_ids} @> ${JSON.stringify([c.knowledgeId])}::jsonb`,
  ];
  if (c.activeOnly !== false) {
    preds.push(sql`(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')`);
  }
  if (c.difficultyMin != null) preds.push(sql`${question.difficulty} >= ${c.difficultyMin}`);
  if (c.difficultyMax != null) preds.push(sql`${question.difficulty} <= ${c.difficultyMax}`);
  if (c.compositeParentOnly) {
    preds.push(isNull(question.parent_question_id));
    preds.push(
      sql`EXISTS (SELECT 1 FROM ${question} AS c WHERE c.parent_question_id = ${question.id})`,
    );
  }

  const useVector = c.queryEmbedding != null && c.queryEmbedding.length > 0;
  if (useVector) preds.push(sql`${question.embedding} IS NOT NULL`);

  const orderBy: SQL[] = useVector
    ? [sql`${question.embedding} <=> ${toSqlVector(c.queryEmbedding as number[])}::vector`]
    : [asc(question.created_at), asc(question.id)];

  const q = db
    .select({ id: question.id, difficulty: question.difficulty })
    .from(question)
    .where(and(...preds))
    .orderBy(...orderBy);

  return c.limit != null ? q.limit(c.limit) : q;
}
