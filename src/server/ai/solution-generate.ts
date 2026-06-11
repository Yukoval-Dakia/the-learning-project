// YUK-193 — Lazy AI reference-solution generator (spec §2).
//
// Runs SolutionGenerateTask through the AI runner (which logs the run to the AI
// log — evidence-first, ADR-0005 spirit), parses the structured output, and
// writes it MERGE-PRESERVING into question.rubric_json + question.reference_md.
// This is the "fuel" that makes the shipped StepsJudge/SemanticJudge usable on
// real ingested questions (which arrive with no rubric_json).
//
// Robustness (spec §2.4): a missing key / LLM throw / unparseable output is a
// LOGGED SKIP — never a thrown 500, never a retry storm. The caller (solve
// orchestrator) degrades gracefully; the manual flow is untouched. Lazy +
// idempotent (skip when reference_solution already exists, unless regenerate).
import { eq } from 'drizzle-orm';
import type { z } from 'zod';

import { Rubric } from '@/core/schema/business';
import { SolutionGenerateOutput } from '@/core/schema/solution';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';

// `RubricT` is not exported from business.ts (it's a private alias inside
// db/schema.ts). Derive the type locally from the single-source-of-truth Rubric
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

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

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
  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;

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
    const { text } = await runTaskFn('SolutionGenerateTask', input, { db, subjectProfile });
    parsed = SolutionGenerateOutput.parse(extractJsonObject(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[generateReferenceSolution] logged-skip for ${questionId}: ${reason}`);
    return { status: 'skipped_error', reason };
  }

  // Merge-preserving: keep any existing criteria/keywords/required_points/
  // acceptable_answers, replace only reference_solution. A question with no
  // prior rubric gets a minimal valid Rubric (criteria: []).
  const prior = Rubric.safeParse(row.rubric_json);
  const base: RubricT = prior.success ? prior.data : { criteria: [] };
  const mergedRubric = {
    ...base,
    reference_solution: parsed.reference_solution,
    // provenance marker (spec §2.1) — lets a human distinguish AI-generated
    // reference solutions from authored ones. Lives alongside the typed Rubric
    // keys; Rubric.parse() ignores unknown keys on read so this is safe.
    reference_solution_source: 'ai_generated' as const,
  };

  await db
    .update(question)
    .set({
      rubric_json: mergedRubric as RubricT,
      reference_md: parsed.worked_solution_md,
      updated_at: new Date(),
    })
    .where(eq(question.id, questionId));

  return { status: 'generated', final_answer: parsed.reference_solution.final_answer };
}
