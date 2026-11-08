// 增量 1 — unified pool-fetch operator. Generalizes the ad-hoc
// pool query in queryExistingPool (sourcing-sequence.ts) into one operator that
// composes authoritative scalar filters + KC containment (GIN'd knowledge_ids) +
// OPTIONAL pgvector similarity ordering. This is the
// retrieval-substrate consumer seam; increment 1 only ADDS the operator + proves
// the hybrid query — it does NOT migrate any live consumer (that's increment 2).
// NOT in increment 1: answer_class filtering (gated on answer_class
// freshness — on-write/re-derive — so a reader can't consume stale/NULL classes);
// soft dims (cause/mastery/syllabus, unmaterialized); cross-KC / effective-domain
// (app-layer derived, not a SQL column).
// ⚠️ INCREMENT-2 MIGRATION CONTRACT — poolFetch is NOT a drop-in for
// queryExistingPool. The WHERE clause matches the legacy shape plus the
// YUK-1603 embed-currency predicate (vector ordering only over current-revision
// vectors), but poolFetch returns the
// RAW scalar pool ({id, difficulty}) only. queryExistingPool additionally (a)
// filters in-memory by `answerClassCompatible(r.kind, kind)` (sourcing-sequence.ts) so a node
// full of off-class rows can't short-circuit the request (the A2 regression;
// the filter compares implied answer class, not label identity — a
// `reading` row DOES satisfy a `computation` request, both semantic), (b) ranks
// by `compareBySourceTierThenWhitelist` (authentic-first,
// off-whitelist demoted), and (c) slices to limit AFTER that sort. A consumer
// migrating onto poolFetch MUST re-apply the kind filter + tier sort + slice on
// top, and project source/metadata, or it will silently change selection.

import { type SQL, and, asc, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { embedCurrencyPredicate } from '@/db/embed-currency';
import { notDraftPredicate, questionSuspendedPredicate } from '@/db/predicates';
import { question } from '@/db/schema';
import { toSqlVector } from '@/db/vector';

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
   * references it via parent_question_id (in practice a question_part; the EXISTS
   * does not constrain child kind, matching queryExistingPool). */
  compositeParentOnly?: boolean;
  /** When non-empty, order by cosine distance to this query vector (hybrid retrieval);
   * rows with NULL embedding are excluded. Otherwise order by created_at, id. */
  queryEmbedding?: number[] | null;
  /** Max rows. undefined → no limit. */
  limit?: number;
}

export interface PoolRow {
  id: string;
  difficulty: number;
  // INCREMENT-2 — projected unconditionally so the consumer (queryExistingPool) can run
  // its in-memory 合约五 tier sort (deriveSourceTier reads source + metadata) and kind
  // filter (answerClassCompatible reads kind) WITHOUT re-querying. Additive: existing callers that
  // only read id/difficulty are unaffected.
  source: string;
  kind: string;
  metadata: Record<string, unknown> | null;
  // NULL≡active.
  draft_status: string | null;
  // Same expression as ORDER BY. NULL when there is no query vector.
  cosine_distance: number | null;
}

/** Fetch a candidate question pool by composite scalar filters + KC containment,
 * optionally ranked by pgvector similarity. Pure read; no writes. */
export async function poolFetch(db: Db, c: PoolFetchCriteria): Promise<PoolRow[]> {
  const preds: SQL[] = [
    sql`${question.knowledge_ids} @> ${JSON.stringify([c.knowledgeId])}::jsonb`,
    // contract admission gate : suspended/withdrawn groups are
    // never pool candidates (group-root resolved via COALESCE(parent,id)).
    // Absent lifecycle row ⇒ legacy ⇒ passes (bridge pre-cutover).
    questionSuspendedPredicate(question),
  ];
  if (c.activeOnly !== false) {
    preds.push(notDraftPredicate(question.draft_status));
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
  // YUK-1603 — vector ordering only over current-revision vectors; a stale vector
  // must not shape the pool order.
  if (useVector) {
    preds.push(sql`${question.embedding} IS NOT NULL`, embedCurrencyPredicate(question));
  }

  // INCREMENT-3 — distance expression reused for both the ORDER BY and the cosine_distance
  // projection (single truth: the column the consumer thresholds on IS the column it sorts
  // by). NULL projection in scalar mode (no query vector → no distance to compute).
  const distanceExpr = useVector
    ? sql<number>`${question.embedding} <=> ${toSqlVector(c.queryEmbedding as number[])}::vector`
    : sql<number | null>`NULL`;

  const orderBy: SQL[] = useVector
    ? [distanceExpr as SQL]
    : [asc(question.created_at), asc(question.id)];

  const q = db
    .select({
      id: question.id,
      difficulty: question.difficulty,
      // INCREMENT-2 — source/kind/metadata feed the consumer's in-memory tier sort +
      // kind filter (queryExistingPool). Projection-only; does not touch WHERE/ORDER.
      source: question.source,
      kind: question.kind,
      metadata: question.metadata,
      // draft_status and cosine_distance are projection-only and do not touch WHERE.
      // Distance reuses the ORDER BY expression. Callers that ignore these fields are unaffected.
      draft_status: question.draft_status,
      cosine_distance: distanceExpr,
    })
    .from(question)
    .where(and(...preds))
    .orderBy(...orderBy);

  return c.limit != null ? q.limit(c.limit) : q;
}
