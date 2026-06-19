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
  /** B4 (YUK-386) — answer_class hard filter (NULL-lenient). When set, restrict the pool to
   *  rows whose persisted answer_class equals this value OR is NULL. NULL≡un-backfilled tail
   *  (A3 only fills NEW writes + the backfill job; legacy rows are NULL) — those MUST NOT be
   *  hard-excluded, so the predicate is `(answer_class = $X OR answer_class IS NULL)`, never a
   *  bare equality. null/undefined → NO answer_class constraint (current behaviour; the column
   *  is not touched). The matcher only passes this when MATCHER_ANSWER_CLASS_FILTER is on AND
   *  the Demand declares answerClass — off → this stays undefined → WHERE byte-identical. */
  answerClass?: string | null;
  /** Max rows. undefined → no limit. */
  limit?: number;
}

export interface PoolRow {
  id: string;
  difficulty: number;
  // INCREMENT-2 — projected unconditionally so the consumer (queryExistingPool) can run
  // its in-memory 合约五 tier sort (deriveSourceTier reads source + metadata) and kind
  // filter (kindsMatch reads kind) WITHOUT re-querying. Additive: existing callers that
  // only read id/difficulty are unaffected. The matcher (inc-3) reuses these too.
  source: string;
  kind: string;
  metadata: Record<string, unknown> | null;
  // INCREMENT-3 — matcher reads draft_status to branch active/draft (§3.2). NULL≡active.
  draft_status: string | null;
  // INCREMENT-3 — matcher reads distance for the cosine threshold filter (§4); same source
  // as the ORDER BY (single truth), analogous to inc-2 widening source/kind/metadata. NULL
  // when no queryEmbedding (scalar mode has no distance to project).
  cosine_distance: number | null;
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
  // B4 (YUK-386) — answer_class hard filter, NULL-lenient. Additive predicate, pushed ONLY
  // when the caller passes a concrete answerClass (matcher: flag-gated). A row is eligible iff
  // its answer_class matches OR is NULL (the un-backfilled legacy tail — A3 fills new writes
  // only — must stay eligible, never silently dropped). Absent → no predicate → WHERE
  // byte-identical to pre-B4. A faithful read-time derive (deriveAnswerClass) would need to
  // replicate the TS classifier's choices-first + keyword-sensitivity logic in SQL CASE, which
  // risks drift from the single canonical classifier; the NULL-lenient equality keeps the
  // single source of truth (deriveAnswerClass on write / backfill) and corrects the NULL tail
  // over time as coverage approaches 100%.
  if (c.answerClass != null) {
    preds.push(
      sql`(${question.answer_class} = ${c.answerClass} OR ${question.answer_class} IS NULL)`,
    );
  }
  if (c.compositeParentOnly) {
    preds.push(isNull(question.parent_question_id));
    preds.push(
      sql`EXISTS (SELECT 1 FROM ${question} AS c WHERE c.parent_question_id = ${question.id})`,
    );
  }

  const useVector = c.queryEmbedding != null && c.queryEmbedding.length > 0;
  if (useVector) preds.push(sql`${question.embedding} IS NOT NULL`);

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
      // INCREMENT-3 — draft_status (active/draft branch) + cosine_distance (threshold filter)
      // for the matcher. Projection-only; does not touch WHERE/ORDER (distance reuses the
      // ORDER BY expression). Additive: inc-1/2 callers that ignore these fields are unaffected.
      draft_status: question.draft_status,
      cosine_distance: distanceExpr,
    })
    .from(question)
    .where(and(...preds))
    .orderBy(...orderBy);

  return c.limit != null ? q.limit(c.limit) : q;
}
