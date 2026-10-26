// YUK-193 — lazy AI reference-solution generator (spec §2).
//
// Runs SolutionGenerateTask through the runner (run logging included), parses the
// structured output, and writes it MERGE-PRESERVING into question.rubric_json +
// question.reference_md. This is the "fuel" that makes the shipped judges usable
// on ingested questions, which arrive without a rubric_json.
//
// Robustness: a missing key, LLM throw or unparseable output is a LOGGED SKIP —
// never a 500, never a retry storm. Lazy + idempotent (skip when a reference
// already exists, unless regenerate).
import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';

import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/public';
import { embedHash, questionEmbedText } from '@/core/embed-source';
import { Rubric } from '@/core/schema/business';
import { SolutionGenerateOutput } from '@/core/schema/solution';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';

// `RubricT` is private inside db/schema.ts; derive it locally from the Rubric
// schema so the merged write matches `question.rubric_json`'s `$type<RubricT>()`.
type RubricT = z.infer<typeof Rubric>;

export type SolutionGenerateRunTaskFn = (
  kind: string,
  input: unknown,
  ctx: unknown,
) => Promise<{ text: string }>;

export interface GenerateReferenceSolutionParams {
  db: Db;
  questionId: string;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: SolutionGenerateRunTaskFn;
  /** Overwrite an existing reference_solution. Default false (idempotent skip). */
  regenerate?: boolean;
}

export type GenerateReferenceSolutionResult =
  | { status: 'generated'; final_answer: string }
  | { status: 'skipped_exists' }
  | { status: 'skipped_not_found' }
  | { status: 'skipped_error'; reason: string };

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('SolutionGenerateTask output did not contain a JSON object');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function existingReferenceSolution(rawRubric: unknown): boolean {
  const parsed = Rubric.safeParse(rawRubric);
  return parsed.success && parsed.data.reference_solution !== undefined;
}

export async function generateReferenceSolution(
  params: GenerateReferenceSolutionParams,
): Promise<GenerateReferenceSolutionResult> {
  const { db, questionId } = params;
  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(db);

  const [row] = await db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      choices_md: question.choices_md,
      rubric_json: question.rubric_json,
      knowledge_ids: question.knowledge_ids,
      metadata: question.metadata,
      parent_question_id: question.parent_question_id,
    })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);

  if (!row) return { status: 'skipped_not_found' };

  if (!params.regenerate && existingReferenceSolution(row.rubric_json)) {
    return { status: 'skipped_exists' };
  }

  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, row.knowledge_ids);

  // existing answers / analysis are advisory hints (an ingested question may
  // carry Tencent's RightAnswer / AnswerAnalysis) — feed as hint, not truth.
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const input = {
    prompt_md: row.prompt_md,
    kind: row.kind,
    subject_id: subjectProfile.id,
    choices_md: row.choices_md ?? [],
    existing_answers_hint: row.reference_md ?? meta.tencent_right_answer ?? null,
    existing_analysis_hint: meta.tencent_answer_analysis ?? null,
    figures_hint: null,
  };

  let parsed: ReturnType<typeof SolutionGenerateOutput.parse>;
  try {
    const { text } = await runTaskFn('SolutionGenerateTask', input, { subjectProfile });
    parsed = SolutionGenerateOutput.parse(extractJsonObject(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[generateReferenceSolution] logged-skip for ${questionId}: ${reason}`);
    return { status: 'skipped_error', reason };
  }

  // Merge-preserving: keep existing criteria/keywords and replace only
  // reference_solution. A question without a rubric gets a minimal valid one.
  const prior = Rubric.safeParse(row.rubric_json);
  const base: RubricT = prior.success ? prior.data : { criteria: [] };
  const mergedRubric = {
    ...base,
    reference_solution: parsed.reference_solution,
    // Provenance marker (spec §2.1): lets a human tell AI-generated references
    // from authored ones. Rubric.parse() ignores unknown keys on read.
    reference_solution_source: 'ai_generated' as const,
  };

  // Write-guard: unless regenerating, write ONLY while reference_md is still null.
  // A concurrent OCR enroll/import or manual edit may have set a real reference
  // between SELECT and UPDATE (TOCTOU) — an AI guess must never clobber it. A
  // zero-row match means one landed concurrently, so the backfill counts a skip.
  const updateWhere = params.regenerate
    ? eq(question.id, questionId)
    : and(eq(question.id, questionId), isNull(question.reference_md));
  // YUK-1043 (review P1-6, reference backfill row) — an AI reference changes the
  // scoring basis, so the UPDATE and the unified publish share one transaction;
  // writing a published column without minting a new version is not allowed. A new
  // scoring basis invalidates prior admission evidence (P1-5) and folds
  // withheld/unverified_rules to pending re-verification.
  //
  // ADR-0072 LIGHT — reference_md feeds the question's embedding source text, so
  // this write point owes the same hash-invalidation duty as editQuestion: when the
  // merged source digest differs, null the embedding and stamp the new hash in the
  // same UPDATE. The nightly embed_backfill (embedding IS NULL or stale version)
  // then re-embeds; otherwise stale vectors keep matching pre-backfill semantics.
  const written = await db.transaction(async (tx) => {
    // P1-1 (second review) — lock order is root→child: for a child part, lock the
    // group root before touching the row. A single question is its own root, so
    // the UPDATE's own row lock already orders root-first.
    if (row.parent_question_id != null) {
      await tx
        .select({ id: question.id })
        .from(question)
        .where(eq(question.id, row.parent_question_id))
        .for('update')
        .limit(1);
    }
    const [locked] = await tx
      .select({
        prompt_md: question.prompt_md,
        choices_md: question.choices_md,
        embed_content_hash: question.embed_content_hash,
      })
      .from(question)
      .where(updateWhere)
      .for('update')
      .limit(1);
    if (!locked) return [];
    // Hash the content being written, after concurrent edits have settled under the row lock.
    const nextEmbedHash = embedHash(
      questionEmbedText({
        prompt_md: locked.prompt_md,
        reference_md: parsed.worked_solution_md,
        choices_md: locked.choices_md,
      }),
    );
    const updated = await tx
      .update(question)
      .set({
        rubric_json: mergedRubric as RubricT,
        reference_md: parsed.worked_solution_md,
        updated_at: new Date(),
        ...(nextEmbedHash !== locked.embed_content_hash
          ? { embedding: null, embed_content_hash: nextEmbedHash }
          : {}),
      })
      .where(updateWhere)
      .returning({ id: question.id });
    if (updated.length === 0) return updated;
    await publishQuestionGroupFromRow(tx, {
      rootId: questionId,
      actorRef: 'solution-generate:reference_backfill',
      now: new Date(),
    });
    return updated;
  });

  if (written.length === 0) return { status: 'skipped_exists' };

  return { status: 'generated', final_answer: parsed.reference_solution.final_answer };
}
