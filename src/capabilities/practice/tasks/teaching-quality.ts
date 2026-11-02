import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskOutput } from './parse-output';

// teaching_quality VerifyCheck (YUK-578) — an independent judge from the closed-book
// QuizVerifyTask. Reads only question data (prompt/reference/rubric/choices), no
// runtime data, and scores three pedagogical axes: 题干清晰度 / 唯一正解性 /
// 干扰项诊断力（仅选择题）. quiz_verify holds a confident fail for review, never
// promotes. Subject-neutral inline prompt; maxIterations 1, no tools.

// The prompt declares exactly clarity / unique_answer / distractor_power? / summary.
// The consumer (runTeachingQualityCheck in practice/server/quiz/verify-framework.ts)
// degrades a missing mandatory axis to a non-blocking 'unsupported' verdict rather
// than trusting a partial payload.
const TeachingQualityAxisSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  reason: z.string(),
});

export const TeachingQualityOutput = z.object({
  clarity: TeachingQualityAxisSchema,
  unique_answer: TeachingQualityAxisSchema,
  distractor_power: TeachingQualityAxisSchema.optional(),
  summary: z.string().optional(),
});

export type TeachingQualityOutputT = z.infer<typeof TeachingQualityOutput>;

export const teachingQualityTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'TeachingQualityTask',
    description:
      'YUK-578 (入池前审题闸) — teaching_quality VerifyCheck for tier3/4 quiz_gen drafts. Reads ONLY the question面 data (prompt_md / kind / choices_md / reference_md / rubric_json / is_choice) and scores three pedagogical axes: clarity (题干无歧义), unique_answer (唯一正解；rubric 有容错声明的算满足), and distractor_power (干扰项诊断力，仅选择题；非选择题跳过). Output = { clarity, unique_answer, distractor_power?, summary } with per-axis { verdict: pass|fail, reason }. CONSERVATIVE (宁可漏过不误杀真题): only fail on a genuine defect. Single structured-output call, text-only, no tool loop. quiz_verify consumes it: a confident fail holds the draft for review (needs_review), never promotes.',
    defaultProvider: 'xiaomi',
    // Text-only reasoning, no vision — same tier as QuizVerifyTask / SolutionGenerateTask.
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // Subject-neutral inline SoT prompt; any prompt change must be re-validated
    // against the mini golden set in practice/server/quiz/verify-framework.test.ts.
    prompt: {
      kind: 'inline',
      text: 'You are an exam-item quality reviewer for a personal learning tool. You review ONE draft question (审题) BEFORE it enters the practice pool. An ambiguous or multi-answer question silently corrupts the learner\'s ability estimate — worse than an outright factual error — so be strict, but conservative (宁可漏过不误杀真题): only fail an axis on a GENUINE defect you can name, never on style or difficulty.\n\nINPUT (a JSON object): `prompt_md` (the question stem), `kind`, `choices_md` (the options array; empty for non-choice), `reference_md` (the declared answer, may be null), `rubric_json` (grading rubric — may declare acceptable answer variants / tolerance), and `is_choice` (true iff this is a choice question — TRUST THIS, do not re-infer).\n\nSCORE EXACTLY THREE AXES, each a `{ "verdict": "pass" | "fail", "reason": "<one concise sentence>" }`:\n\n1. `clarity` (题干清晰度): Is the stem unambiguous and self-contained — can a competent learner understand exactly what is being asked, with no undefined referents, missing context, or contradictory constraints? Fail ONLY when the stem is genuinely ambiguous or under-specified.\n\n2. `unique_answer` (唯一正解性): Is there exactly one defensibly-correct answer? Fail when a second option / phrasing is also defensibly correct, or the declared answer is not the only right one. IMPORTANT: if `rubric_json` DECLARES acceptable answer variants, equivalents, or a tolerance/range (e.g. answer_equivalents, tolerance, acceptable ranges), then multiple accepted forms are INTENDED — treat the unique-answer axis as SATISFIED (pass) as long as they are all genuinely correct.\n\n3. `distractor_power` (干扰项诊断力): CHOICE QUESTIONS ONLY. If `is_choice` is true, judge whether the wrong options (distractors) are plausible and diagnostic — each should correspond to a real mistake or misconception a learner might hold, not be an obvious throwaway. Fail when the distractors have no diagnostic value (absurd, duplicated, or trivially eliminable). If `is_choice` is FALSE, OMIT the `distractor_power` key entirely (do not emit it for non-choice questions).\n\nOUTPUT: strict JSON only, no markdown fences, no prose outside the JSON. Keys: `clarity`, `unique_answer`, `distractor_power` (only when is_choice), and `summary` (a one-sentence overall note).\n\nExample (choice question, is_choice=true — FOUR keys, distractor_power included): {"clarity":{"verdict":"pass","reason":"..."},"unique_answer":{"verdict":"pass","reason":"..."},"distractor_power":{"verdict":"pass","reason":"..."},"summary":"..."}\n\nExample (non-choice question, is_choice=false — EXACTLY THREE keys, distractor_power OMITTED): {"clarity":{"verdict":"pass","reason":"..."},"unique_answer":{"verdict":"pass","reason":"..."},"summary":"..."}',
    },
  },
  outputSchema: TeachingQualityOutput,
  parseText: (text) => parseTaskOutput(text, 'TeachingQualityTask', TeachingQualityOutput),
} satisfies TaskSpec<unknown, TeachingQualityOutputT>;
