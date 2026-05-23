import { z } from 'zod';

import { JudgeKind as JudgeKindSchema, QuestionKind, Rubric } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import type { SubjectProfile } from '@/subjects/profile';
import { type JudgeKind, judgeRouterV2 } from '.';

export const RUNNABLE_ROUTES = new Set<JudgeKind>([
  'exact',
  'keyword',
  'semantic',
  'steps',
  'unit_dimension',
]);

export const FUTURE_JUDGE_ROUTES = {
  rubric: 'future: rubric judge needs weighted criteria runner and score semantics',
  multimodal_direct: 'future: multimodal answer judging needs image/audio inputs',
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
}

export interface JudgeAnswerResult {
  route: JudgeKind;
  result: JudgeResultV2T;
}

function unsupportedResult(
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

function parseRoute(value: string | null | undefined): JudgeKind | null {
  const parsed = JudgeKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isPreferred(profile: SubjectProfile, route: JudgeKind): boolean {
  return profile.judgePolicy.preferredRoutes.includes(route);
}

export function resolveQuestionJudgeRoute(
  q: JudgeQuestionRow,
  subjectProfile: SubjectProfile,
): JudgeKind {
  const override = parseRoute(q.judge_kind_override);
  if (override) return override;

  // A question with persisted choices is structurally a multiple/single-choice
  // item regardless of the kind string the subject profile uses
  // (e.g. wenyan exposes 'single_choice' / 'multiple_choice' while the
  // QuestionKind enum still calls the canonical kind 'choice'). The structure
  // is the source of truth: if there are choices, the only safe default is
  // exact match against reference_md — never spend LLM budget on a semantic
  // judge for what is fundamentally a string compare.
  const choices = q.choices_md ?? [];
  if (choices.length > 0) return 'exact';

  if (
    subjectProfile.id === 'physics' &&
    isPreferred(subjectProfile, 'unit_dimension') &&
    (q.kind === 'calculation' || q.kind === 'computation')
  ) {
    return 'unit_dimension';
  }

  const kind = QuestionKind.safeParse(q.kind).success ? q.kind : 'short_answer';
  const rubric = parseRubric(q.rubric_json);
  const keywords = nonEmpty(rubric?.keywords);

  if (kind === 'choice' || kind === 'true_false') return 'exact';
  if (kind === 'fill_blank') return keywords.length > 0 ? 'keyword' : 'exact';
  if (kind === 'computation') return keywords.length > 0 ? 'keyword' : 'semantic';
  // M2.1 (2026-05-22): derivation always routes via steps@1 for profiles that
  // declare it (math); other profiles fall back to semantic if preferred, else
  // keyword. M2.2 made 'steps' runnable via runStepsJudge (vision LLM call).
  if (kind === 'derivation') {
    if (isPreferred(subjectProfile, 'steps')) return 'steps';
    return isPreferred(subjectProfile, 'semantic') ? 'semantic' : 'keyword';
  }
  if (kind === 'short_answer' || kind === 'reading' || kind === 'translation' || kind === 'essay') {
    return isPreferred(subjectProfile, 'semantic') ? 'semantic' : 'keyword';
  }
  return 'exact';
}

function buildLocalJudgeQuestion(q: JudgeQuestionRow, route: JudgeKind): Record<string, unknown> {
  const rubric = parseRubric(q.rubric_json);
  if (route === 'keyword') {
    return { keywords: nonEmpty(rubric?.keywords) };
  }
  return { reference: q.reference_md ?? '' };
}

function semanticInput(
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
    // vision-aware semantic / steps judges. Current SemanticJudgeTask
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

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

async function runSemanticJudge(params: JudgeAnswerParams): Promise<JudgeResultV2T> {
  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;
  try {
    const result = await runTaskFn(
      'SemanticJudgeTask',
      {
        question: semanticInput(params.question, params.subjectProfile),
        answer: { content: params.answer_md },
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
  const route = resolveQuestionJudgeRoute(params.question, params.subjectProfile);
  if (!RUNNABLE_ROUTES.has(route)) {
    return {
      route,
      result: unsupportedResult(route, `judge route '${route}' is not implemented`, {
        route,
        allowed_future_routes: FUTURE_JUDGE_ROUTES,
      }),
    };
  }

  if (route === 'semantic') {
    return { route, result: await runSemanticJudge(params) };
  }
  if (route === 'steps') {
    const { runStepsJudge } = await import('./steps-judge');
    return {
      route,
      result: await runStepsJudge({
        db: params.db,
        question: params.question,
        answer_md: params.answer_md,
        student_image_refs: params.student_image_refs,
        subjectProfile: params.subjectProfile,
        runTaskFn: params.runTaskFn,
      }),
    };
  }

  const result = judgeRouterV2({
    kind: route,
    question: buildLocalJudgeQuestion(params.question, route),
    answer: { content: params.answer_md },
  });
  return { route, result };
}
