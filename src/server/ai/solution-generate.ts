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
import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';

import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/public';
import { Rubric } from '@/core/schema/business';
import { SolutionGenerateOutput } from '@/core/schema/solution';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';

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

  // Write-guard (concurrent-safe): unless an explicit regenerate, write ONLY when reference_md is
  // STILL null. A concurrent writer (an OCR enroll/import, a manual edit) may have set a REAL
  // reference between our initial SELECT and this UPDATE (TOCTOU) — we must never clobber an
  // externally-set answer with an AI guess. If the guard matches 0 rows a reference landed
  // concurrently → skip (the nightly reference_answer_backfill counts it skipped, not filled).
  const updateWhere = params.regenerate
    ? eq(question.id, questionId)
    : and(eq(question.id, questionId), isNull(question.reference_md));
  // YUK-1043（复审 P1-6，§2 矩阵 reference backfill 行）—— 生成参考答案改变
  // 评分依据：UPDATE 与统一发布同事务，不能直接改已发布列后不铸新版。新
  // scoring basis ⇒ 旧 admission evidence 不再适用（P1-5），preserve 折叠
  // withheld/unverified_rules —— 待重新核验后再准入（来源标识已在 rubric
  // reference_solution_source='ai_generated' 留痕）。
  const written = await db.transaction(async (tx) => {
    // P1-1（第二轮复审）—— 锁序 root→child：目标是子 part 时先锁组根再改子行
    //（backfill 更新的可能是组内子行；FromRow 的根解析不做子行锁定，所以这
    // 里显式先锁）。单题时被更新行自身即根，UPDATE 取锁天然根优先。
    if (row.parent_question_id != null) {
      await tx
        .select({ id: question.id })
        .from(question)
        .where(eq(question.id, row.parent_question_id))
        .for('update')
        .limit(1);
    }
    const updated = await tx
      .update(question)
      .set({
        rubric_json: mergedRubric as RubricT,
        reference_md: parsed.worked_solution_md,
        updated_at: new Date(),
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
