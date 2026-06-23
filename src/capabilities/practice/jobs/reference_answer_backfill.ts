// YUK-489 (P4a) — idempotent reference-answer backfill. P3 decoupled cold-start-
// bridge ③ (reference-answer generation) from KC tagging: a prompt-only OCR
// question now persists with reference_md = null (auto-enroll.ts ~:760,
// image-candidate-accept.ts ~:717/794). THIS job fills those nulls nightly,
// independently of tagging, by REUSING the existing solver
// generateReferenceSolution (NO new task/prompt) — it merges rubric_json + sets
// reference_md + stamps reference_solution_source:'ai_generated', and swallows
// LLM/parse errors into {status:'skipped_error'} (solution-generate.ts §2.4).
//
// Trigger = reference_md IS NULL (mirror embed_backfill / answer_class_backfill's
// NULL-predicate). Idempotent: a row with reference_md already set is never in
// scan; a second run with none left is a no-op.
//
// SUBJECT-RESOLVABILITY GATE (spec case 5): generateReferenceSolution resolves
// the subjectProfile via resolveSubjectProfileForKnowledgeIds(db, knowledge_ids),
// which falls back to the DEFAULT profile for an empty/orphaned id list (it does
// NOT throw — see subject-profile.ts:11-12). The P4a contract is stricter: only
// attempt rows with ≥1 knowledge_id so the profile is genuinely resolvable; rows
// with no knowledge_id are EXCLUDED by the SELECT PREDICATE
// (jsonb_array_length(knowledge_ids) > 0) — never fetched, so they cannot consume the
// LIMIT budget and, with oldest-first ordering, starve newer generate-able rows
// (augment #569). Gating in app code after the SELECT had exactly that starvation bug.
//
// PER-ROW FAILURE CONTRACT (mirror embed_backfill): a single row's
// skipped_error leaves that row's reference_md NULL (next nightly run retries) and
// the batch continues to the next row — one bad row never aborts the batch. Only
// a genuinely-escaping infra fault re-throws (pg-boss DLQ retry).

import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import {
  type GenerateReferenceSolutionParams,
  type GenerateReferenceSolutionResult,
  type SolutionGenerateRunTaskFn,
  generateReferenceSolution,
} from '@/server/ai/solution-generate';
import { and, asc, isNull, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

export interface ReferenceAnswerBackfillResult {
  /** rows whose reference_md IS NULL that the SELECT returned this run. */
  scanned: number;
  /** rows generateReferenceSolution filled (status:'generated'). */
  filled: number;
  /** rows skipped: no knowledge_id (subject unresolvable) OR solver skipped_error
   *  / skipped_exists / skipped_not_found. Left NULL where applicable for retry. */
  skipped: number;
}

export interface RunReferenceAnswerBackfillOpts {
  /** batch size; mirror embed_backfill's default. */
  limit?: number;
  /** inject in tests; threaded into generateReferenceSolution's runTaskFn seam
   *  (model-free). Ignored when `generateFn` is supplied. */
  runTaskFn?: SolutionGenerateRunTaskFn;
  /** full override of the solver call (tests stub the whole outcome). Default =
   *  the real generateReferenceSolution (threaded with runTaskFn). */
  generateFn?: (
    params: GenerateReferenceSolutionParams,
  ) => Promise<GenerateReferenceSolutionResult>;
}

/** Idempotent: fill reference_md for up to `limit` questions whose reference_md
 *  IS NULL and which carry ≥1 knowledge_id (resolvable subject). Reuses
 *  generateReferenceSolution (write-guards + error-skips internally). Returns
 *  {scanned, filled, skipped}.
 *
 *  DRAFT_STATUS SCOPE: scan ALL reference_md-null rows regardless of draft_status
 *  (mirror answer_class_backfill, which is draft_status-agnostic). A draft pool
 *  question still benefits from a reference answer the moment it is promoted, and
 *  generateReferenceSolution does not consult draft_status — so excluding drafts
 *  would only leave them ungenerated with no upside. */
export async function runReferenceAnswerBackfill(
  db: Db,
  opts: RunReferenceAnswerBackfillOpts = {},
): Promise<ReferenceAnswerBackfillResult> {
  const limit = opts.limit ?? 50;
  const generateFn = opts.generateFn ?? generateReferenceSolution;

  const rows = await db
    .select({ id: question.id })
    .from(question)
    .where(
      and(
        isNull(question.reference_md),
        // Subject-resolvability gate pushed into the PREDICATE (augment #569): a row with no
        // knowledge_id has no resolvable subject (the solver would fall back to the default
        // profile + generate against a guess), so it must never be fetched. Gating in app code
        // instead (a post-SELECT skip) let knowledge_ids=[] rows consume the LIMIT budget and,
        // with oldest-first ordering, STARVE the newer generate-able rows every nightly run.
        // knowledge_ids is jsonb (GIN-indexed) → jsonb_array_length.
        sql`jsonb_array_length(${question.knowledge_ids}) > 0`,
      ),
    )
    // Oldest-first: an LLM-per-row job at batch 50 needs fairness — without a stable order a
    // repeatedly-failing (skipped_error) or perpetually-overflowed row could starve across nightly
    // runs. created_at ASC guarantees the oldest generate-able null-reference rows are retried
    // first (OCR #569). Combined with the predicate gate above, the LIMIT now returns only
    // generate-able rows, so no-knowledge_id rows can never crowd them out.
    .orderBy(asc(question.created_at))
    .limit(limit);

  let filled = 0;
  let skipped = 0;

  for (const row of rows) {
    // generateReferenceSolution write-guards (idempotent skip when a
    // reference_solution already exists) + swallows LLM/parse errors into
    // skipped_error. A skipped_error leaves reference_md NULL → next run retries;
    // we count it skipped and CONTINUE (embed_backfill per-row contract), never
    // aborting the batch. Only a genuinely-escaping infra fault propagates.
    const result = await generateFn({
      db,
      questionId: row.id,
      runTaskFn: opts.runTaskFn,
    });

    if (result.status === 'generated') {
      filled += 1;
    } else {
      // skipped_error / skipped_exists / skipped_not_found — all non-fills.
      skipped += 1;
    }
  }

  return { scanned: rows.length, filled, skipped };
}

// pg-boss handler builder (mirrors buildEmbedBackfillHandler / buildAnswerClass-
// BackfillHandler): takes the db injected by register-capability-jobs, runs the
// batch, logs counts. A throw propagates to pg-boss for DLQ retry; per-row
// skipped_error is already absorbed inside runReferenceAnswerBackfill, so a throw
// here is a genuine infra fault (DB down, etc.) → rows stay NULL, next run
// retries.
export function buildReferenceAnswerBackfillHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const { scanned, filled, skipped } = await runReferenceAnswerBackfill(db);
      console.log(
        '[reference_answer_backfill] scanned',
        scanned,
        'filled',
        filled,
        'skipped',
        skipped,
      );
    } catch (err) {
      console.error('[reference_answer_backfill] failed', err);
      throw err;
    }
  };
}
