import { z } from 'zod';

import { Rubric } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
// F0 (PR #309 round-3) — the route resolver now lives in the dependency-light
// leaf `@/server/judge/route-resolve` (see that file's header for the build
// regression it fixes). Re-exported below so this module's public surface is
// unchanged; existing importers keep working.
import { resolveQuestionJudgeRoute } from '@/server/judge/route-resolve';
import type { SubjectProfile } from '@/subjects/profile';
import type { JudgeKind } from '.';

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

const SemanticJudgeOutput = z.object({
  score: z.number().min(0).max(1),
  coarse_outcome: z.enum(['correct', 'partial', 'incorrect']),
  confidence: z.number().min(0).max(1),
  feedback_md: z.string().min(1),
  evidence_json: z.object({
    matched_points: z.array(z.string()).default([]),
    missing_points: z.array(z.string()).default([]),
    notes: z.string().optional(),
  }),
});

type SemanticJudgeOutputT = z.infer<typeof SemanticJudgeOutput>;

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
  runTaskFn?: (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
  /**
   * M2 申诉重判（YUK-316, D15）：用户对先前判定的异议上下文。仅 semantic 路由
   * 消费（rejudge 走 judge_kind_override='semantic' 强制语义复核）；其它路由忽略。
   */
  appeal_context?: { prior_outcome: string; user_reason_md: string };
}

export interface JudgeAnswerResult {
  route: JudgeKind;
  result: JudgeResultV2T;
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

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('semantic judge output did not contain a JSON object');
  }
  return JSON.parse(text.slice(start, end + 1));
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

export async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

export async function runSemanticJudge(params: JudgeAnswerParams): Promise<JudgeResultV2T> {
  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;
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
        db: params.db,
        subjectProfile: params.subjectProfile,
      },
    );
    const parsed = SemanticJudgeOutput.safeParse(extractJsonObject(result.text));
    if (!parsed.success) {
      return unsupportedResult('semantic', 'semantic judge output unsupported', {
        validation_error: parsed.error.issues,
        raw_text: result.text,
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
  return { route: invoked.route, result: invoked.result };
}
