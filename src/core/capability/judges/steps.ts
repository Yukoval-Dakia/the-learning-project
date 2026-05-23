import { RubricReferenceSolution as StepsReferenceSolution } from '@/core/schema/business';
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { z } from 'zod';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

// ----------------------------------------------------------------------------
// Schemas — input from judge runner, LLM output, reference solution shape.
// Runtime execution lives in src/server/ai/judges/steps-judge.ts and is reached
// through src/server/judge/invoker.ts. The shapes follow spec
// docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md §7.
// ----------------------------------------------------------------------------

/**
 * Reference solution shape — comes from the question's rubric_json. For math
 * derivation, the rubric carries:
 *   - expected_signals: 步骤应当体现的核心信号（不是死答案文本）
 *   - final_answer: 最终答案
 *   - answer_equivalents: 学生若打字提交可加速比对的等价表达
 *
 * Single source of truth in @/core/schema/business (M2.2 fix per code review).
 * Re-exported here as `StepsReferenceSolution` to keep the capability-layer
 * naming convention; consumers of either name see the same Zod instance.
 */
export { RubricReferenceSolution as StepsReferenceSolution } from '@/core/schema/business';
export type { RubricReferenceSolutionT as StepsReferenceSolutionT } from '@/core/schema/business';

/**
 * Judge runner input — what the server-side steps runner validates before it
 * composes a weighted JudgeResultV2.
 */
export const StepsJudgeInput = z.object({
  prompt_md: z.string().min(1),
  reference_solution: StepsReferenceSolution,
  // M-1 first-class multimodal carriers; image_refs is asset_id list.
  student_image_refs: z.array(z.string().min(1)).default([]),
  student_text_steps: z.array(z.string().min(1)).optional(),
  student_final_answer_text: z.string().optional(),
  // step_weight ∈ [0, 1]. score = step_weight × Σ verdict_weight / N + (1 - step_weight) × (final_match ? 1 : 0)
  step_weight: z.number().min(0).max(1),
});
export type StepsJudgeInputT = z.infer<typeof StepsJudgeInput>;

/**
 * LLM structured output schema — what the vision LLM returns, parsed and
 * validated before composing JudgeResultV2.
 */
export const StepsLlmOutput = z.object({
  extracted_steps: z.array(
    z.object({
      idx: z.number().int().min(0),
      content: z.string().min(1),
      verdict: z.enum(['correct', 'partial', 'wrong', 'skipped']),
      comment: z.string(),
    }),
  ),
  // LLM 把图里答案转文本 — evidence 用，partial credit 计算不依赖
  extracted_final_answer: z.string(),
  // 一对一对齐 reference_solution.expected_signals（schema 长度由 runner 校验）
  signal_verdicts: z.array(
    z.object({
      signal_idx: z.number().int().min(0),
      verdict: z.enum(['correct', 'partial', 'wrong', 'skipped']),
      comment: z.string(),
    }),
  ),
  final_answer_match: z.boolean(),
  final_answer_comment: z.string(),
  confidence: z.number().min(0).max(1),
});
export type StepsLlmOutputT = z.infer<typeof StepsLlmOutput>;

// ----------------------------------------------------------------------------
// Manifest + core registry fallback.
// ----------------------------------------------------------------------------

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'steps',
  kind: 'judge',
  version: VERSION,
  input_schema: 'StepsJudgeInput',
  output_schema: 'JudgeResultV2 (score_meaning=steps_v1_weighted)',
  // Vision LLM call; far above local exact / keyword.
  cost_class: 'expensive_llm',
  // Vision LLM call is sync from the runner's POV (awaited inside runner).
  latency_class: 'sync',
  stability: 'experimental',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

/**
 * Core registry fallback. steps@1 needs DB access and image loading, so runtime
 * judging must go through JudgeInvoker -> runStepsJudge. Keeping this fallback
 * unsupported prevents callers from accidentally bypassing the server runtime
 * boundary while still allowing profile validation to resolve the capability.
 */
function run(input: JudgeRunInput): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'steps_v1_weighted',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md:
      'steps@1 requires server JudgeInvoker runtime context. Use src/server/judge/invoker.ts.',
    evidence_json: {
      reason: 'server_runtime_required',
      question: input.question,
    },
  };
}

export const stepsV1Capability: JudgeCapabilityRunner = { manifest, run };
