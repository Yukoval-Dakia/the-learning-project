import type { z } from 'zod';

import { type Provider, tasks } from '@/ai/registry';
import { SemanticJudgeOutput, type SemanticJudgeOutputT } from '@/core/capability/judges/semantic';
import { Rubric } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
// F0 (PR #309 round-3) — the route resolver now lives in the dependency-light
// leaf `@/server/judge/route-resolve` (see that file's header for the build
// regression it fixes). Re-exported below so this module's public surface is
// unchanged; existing importers keep working.
import { resolveQuestionJudgeRoute } from '@/server/judge/route-resolve';
import type { SubjectProfile } from '@/subjects/profile';
import type { JudgeKind } from '.';
import { extractJsonObject } from './judge-output-parse';

export { resolveQuestionJudgeRoute };

export const RUNNABLE_ROUTES = new Set<JudgeKind>([
  'exact',
  'keyword',
  'semantic',
  'steps',
  'unit_dimension',
  // YUK-201 — holistic vision-aware judging (runMultimodalDirectJudge via invoker).
  'multimodal_direct',
]);

export const FUTURE_JUDGE_ROUTES = {
  rubric: 'future: rubric judge needs weighted criteria runner and score semantics',
  ai_flexible: 'future: fallback LLM judge needs stronger audit and cost policy',
} as const satisfies Record<string, string>;

const semanticOutputSchema = tasks.SemanticJudgeTask.structuredOutputSchema;
const SEMANTIC_OUTPUT_FORMAT = semanticOutputSchema
  ? zodToJsonSchemaOutputFormat(semanticOutputSchema)
  : undefined;

export interface JudgeQuestionRow {
  id: string;
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  rubric_json: unknown;
  choices_md: string[] | null;
  judge_kind_override: string | null;
  knowledge_ids?: string[] | null;
  metadata?: Record<string, unknown> | null;
  // M-1 (2026-05-21): first-class multimodal carriers.
  // Runnable routes (exact / keyword / semantic) IGNORE these fields — they're
  // wired in for future vision-aware capabilities (steps@1 in M2, etc.).
  // See docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md §7.
  figures?: FigureRefT[];
  image_refs?: string[];
  structured?: StructuredQuestionT | null;
}

export interface JudgeAnswerParams {
  db: Db;
  question: JudgeQuestionRow;
  answer_md: string;
  /**
   * M2.2 fix: student-submitted answer images (NOT question.image_refs which
   * are prompt figures). For steps@1 derivation judging, these are photos
   * of the learner's handwritten work. Spec §7.1 — at least one of
   * { answer_md, student_image_refs } non-empty; runtime asserted by judge.
   *
   * Default `undefined` ⇒ treated as `[]`. M2.3 UI populates this from the
   * answer submission payload; pre-M2.3 callers (no image upload UI yet)
   * leave it unset.
   */
  student_image_refs?: string[];
  subjectProfile: SubjectProfile;
  runTaskFn?: TaskTextRunFn;
  /**
   * YUK-573 (MF6) — optional image fetcher for the two vision routes
   * (steps / multimodal_direct). Structurally identical to the runners' own
   * injectables (StepsImageFetchFn / MultimodalDirectImageFetchFn); declared
   * inline to avoid a value edge back into the runner modules. Omitted →
   * runners fall back to `defaultImageFetch` (R2 + db), main-path behaviour
   * byte-identical. The golden replay harness (scripts/judge-golden-reaudit.ts)
   * injects a stub so image-bearing fixtures replay with zero DB/R2 access.
   */
  imageFetchFn?: (
    assetIds: string[],
    db: Db,
  ) => Promise<Array<{ data: string; mediaType: string }>>;
  /**
   * M2 申诉重判（YUK-316, D15）：用户对先前判定的异议上下文。仅 semantic 路由
   * 消费（rejudge 走 judge_kind_override='semantic' 强制语义复核）；其它路由忽略。
   */
  appeal_context?: { prior_outcome: string; user_reason_md: string };
  /**
   * YUK-212 + YUK-484(B) — StructuredQuestion.id of the target sub-node to grade.
   * When present and resolvable, the invoker narrows the question to that single
   * sub (passage-preserving) BEFORE routing/dispatch so the judge sees only the
   * addressed sub, not its siblings. Absent / unresolvable → whole-row (today's
   * behavior). This is the structured-jsonb axis id — NOT a question_part id.
   */
  part_ref?: string | null;
  /**
   * YUK-594 (D7/D9) — durable-run scoped call overrides. Set ONLY by the
   * `judge_run` pg-boss handler (never the sync HTTP paths). Two effects, both
   * applied in the invoker's runner wrapper (invoker.ts observedRunTaskFn):
   *   - `enableTransientRetry:false` is FORCED on the runner ctx (D7 single-
   *     transient-layer: queue redelivery is the durable handler's ONLY transient
   *     layer, so the vision judges' in-process transient retry stays off →
   *     worst-case paid calls per logical judge = 1 + JOB_RETRY_LIMIT).
   *   - `providerOverride` (when present) is merged into `RunTaskCtx.override.
   *     provider` so the final redelivery can cross to the fallback lane
   *     (anthropic-sub). Reuses the existing per-call `resolveTaskProvider`
   *     override seam — no new plumbing (YUK-594 D9). Omitted → default lane.
   */
  durable?: { providerOverride?: Provider };
}

export interface JudgeAnswerResult {
  route: JudgeKind;
  result: JudgeResultV2T;
  // YUK-589 (K1) — whether a model invocation was attempted for this verdict
  // (threaded straight from the invoker). Consumers stamp `deterministic` when
  // false, never `historical_unknown` off route membership alone.
  modelAttempted: boolean;
  task_run_id?: string;
  execution?: {
    task_kind: string;
    task_run_id?: string;
    input_hash: string;
    prompt_fingerprint: string;
    prompt_template_revision: string;
  };
}

export function unsupportedResult(
  route: JudgeKind,
  feedback: string,
  evidence: Record<string, unknown>,
): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'correctness',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: { id: route, version: '1.0.0' },
    feedback_md: feedback,
    evidence_json: evidence,
  };
}

function parseRubric(raw: unknown): z.infer<typeof Rubric> | null {
  if (raw === null || raw === undefined) return null;
  const parsed = Rubric.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function nonEmpty(values: string[] | undefined): string[] {
  return (values ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
}

// `resolveQuestionJudgeRoute` moved to `@/server/judge/route-resolve` (F0,
// PR #309 round-3) and is re-exported at the top of this file. The private
// helpers it used (`parseRoute` / `isPreferred`) moved with it.

export function buildLocalJudgeQuestion(
  q: JudgeQuestionRow,
  route: JudgeKind,
): Record<string, unknown> {
  const rubric = parseRubric(q.rubric_json);
  if (route === 'keyword') {
    return { keywords: nonEmpty(rubric?.keywords) };
  }
  if (route === 'unit_dimension') {
    return { metadata: q.metadata ?? null, prompt_md: q.prompt_md };
  }
  // YUK-260: the exact judge needs choices_md to resolve letter-form answers
  // ("A" / "BC") against option text. It was dropped here, so choice questions
  // whose reference stored the option text (or letter) never matched the
  // letter (or text) the UI submitted.
  return { reference: q.reference_md ?? '', choices_md: q.choices_md ?? [] };
}

export function semanticInput(
  q: JudgeQuestionRow,
  subjectProfile: SubjectProfile,
): Record<string, unknown> {
  const rubric = parseRubric(q.rubric_json);
  return {
    question_id: q.id,
    kind: q.kind,
    prompt_md: q.prompt_md,
    reference_md: q.reference_md,
    choices_md: q.choices_md ?? [],
    rubric_json: rubric,
    required_points: nonEmpty(rubric?.required_points),
    acceptable_answers: nonEmpty(rubric?.acceptable_answers),
    keywords: nonEmpty(rubric?.keywords),
    // M1 (2026-05-22): profile metadata for downstream LLM tasks.
    // M2 vision judge (steps@1) consumes subject_id / language_style to route
    // image-bearing prompts correctly. SemanticJudgeTask current builder
    // ignores these fields; field is forward-compat.
    subject_profile: {
      id: subjectProfile.id,
      display_name: subjectProfile.displayName,
      language_style: subjectProfile.languageStyle,
    },
    // M-1 (2026-05-21): multimodal carriers — passed through for future
    // vision-aware semantic / steps routes. Current SemanticJudgeTask
    // builder does not consume them; behaviour unchanged.
    figures: q.figures ?? [],
    image_refs: q.image_refs ?? [],
    structured: q.structured ?? null,
  };
}

function normalizeSemanticResult(output: SemanticJudgeOutputT): JudgeResultV2T {
  const capability_ref = { id: 'semantic', version: '1.0.0' };
  if (output.coarse_outcome === 'correct') {
    return {
      score: Math.max(output.score, 0.85),
      score_meaning: 'correctness',
      coarse_outcome: 'correct',
      confidence: output.confidence,
      capability_ref,
      feedback_md: output.feedback_md,
      evidence_json: output.evidence_json,
    };
  }
  if (output.coarse_outcome === 'partial') {
    return {
      score: Math.min(Math.max(output.score, 0.01), 0.84),
      score_meaning: 'correctness',
      coarse_outcome: 'partial',
      confidence: output.confidence,
      capability_ref,
      feedback_md: output.feedback_md,
      evidence_json: output.evidence_json,
    };
  }
  return {
    score: 0,
    score_meaning: 'correctness',
    coarse_outcome: 'incorrect',
    confidence: output.confidence,
    capability_ref,
    feedback_md: output.feedback_md,
    evidence_json: output.evidence_json,
  };
}

export function defaultRunTaskFn(db: Db): TaskTextRunFn {
  return makeRunTaskTextFn(db);
}

/**
 * YUK-759 three-state dispatch:
 * - structured_output present: validate that value and never trust conflicting text;
 * - structured_output null/undefined: preserve the existing char-scan text path;
 * - either path still receives the same Zod second pass and verdict normalization.
 */
export function parseSemanticJudgeResult(result: {
  text: string;
  structured_output?: unknown;
}): ReturnType<typeof SemanticJudgeOutput.safeParse> {
  const candidate =
    result.structured_output !== undefined && result.structured_output !== null
      ? result.structured_output
      : extractJsonObject(result.text, 'semantic judge output');
  return SemanticJudgeOutput.safeParse(candidate);
}

export async function runSemanticJudge(params: JudgeAnswerParams): Promise<JudgeResultV2T> {
  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn(params.db);
  try {
    const result = await runTaskFn(
      'SemanticJudgeTask',
      {
        question: semanticInput(params.question, params.subjectProfile),
        answer: { content: params.answer_md },
        // M2 申诉重判（YUK-316）：system prompt 指示模型复核用户异议。
        ...(params.appeal_context ? { appeal: params.appeal_context } : {}),
      },
      {
        subjectProfile: params.subjectProfile,
        outputFormat: SEMANTIC_OUTPUT_FORMAT,
      },
    );
    const parsed = parseSemanticJudgeResult(result);
    if (!parsed.success) {
      return unsupportedResult('semantic', 'semantic judge output unsupported', {
        validation_error: parsed.error.issues,
        raw_text:
          result.structured_output !== undefined && result.structured_output !== null
            ? JSON.stringify(result.structured_output).slice(0, 4000)
            : result.text,
      });
    }
    return normalizeSemanticResult(parsed.data);
  } catch (err) {
    return unsupportedResult('semantic', 'semantic judge failed; answer was not marked wrong', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function judgeAnswer(params: JudgeAnswerParams): Promise<JudgeAnswerResult> {
  const { createDefaultJudgeInvoker } = await import('@/server/judge/invoker');
  const invoked = await createDefaultJudgeInvoker().invoke(params);
  return {
    route: invoked.route,
    result: invoked.result,
    modelAttempted: invoked.modelAttempted,
    ...(invoked.task_run_id ? { task_run_id: invoked.task_run_id } : {}),
    ...(invoked.execution ? { execution: invoked.execution } : {}),
  };
}
