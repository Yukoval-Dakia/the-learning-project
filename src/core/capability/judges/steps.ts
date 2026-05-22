import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { z } from 'zod';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

// ----------------------------------------------------------------------------
// Schemas — input from judge runner, LLM output, reference solution shape.
// M2.1 defines these so M2.2 (vision LLM impl) can parse / validate without
// re-designing the contract. The shapes follow spec
// docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md §7.
// ----------------------------------------------------------------------------

/**
 * Reference solution shape — comes from the question's rubric_json. For math
 * derivation, the rubric carries:
 *   - expected_signals: 步骤应当体现的核心信号（不是死答案文本）
 *   - final_answer: 最终答案
 *   - answer_equivalents: 学生若打字提交可加速比对的等价表达
 */
export const StepsReferenceSolution = z.object({
  expected_signals: z.array(z.string().min(1)).min(1),
  final_answer: z.string().min(1),
  answer_equivalents: z.array(z.string().min(1)).default([]),
});
export type StepsReferenceSolutionT = z.infer<typeof StepsReferenceSolution>;

/**
 * Judge runner input — what `stepsV1Capability.run()` receives. M2.1 stub
 * does not consume student_* fields beyond shape validation.
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
 * validated before composing JudgeResultV2 in M2.2. M2.1 defines the shape
 * so M2.2 wires `runTaskFn('StepsJudgeTask', ...)` against it.
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
// Manifest + runner stub.
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
  // Until M2.2 ships the real LLM call + sanity check.
  stability: 'experimental',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

/**
 * M2.1 stub — capability registered, route resolvable, but actual execution
 * still gated behind RUNNABLE_ROUTES in question-contract.ts. judgeAnswer
 * never reaches this run() in M2.1 because RUNNABLE_ROUTES = {exact, keyword,
 * semantic} excludes 'steps'. The stub exists so:
 *   1. CapabilityRegistry can register stepsV1Capability
 *   2. SubjectProfile.judgeCapabilities can reference 'steps' and pass validateProfile
 *   3. M2.2 replaces this body with the vision LLM call without touching the
 *      registry / profile / route layer.
 */
function run(input: JudgeRunInput): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'steps_v1_weighted',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md:
      'steps@1 judge skeleton: vision LLM impl ships in M2.2. See docs/superpowers/plans/2026-05-22-math-mvp-m2-1-steps-skeleton.md.',
    evidence_json: {
      phase: 'M2.1-skeleton',
      reason: 'capability registered but run() not yet implemented',
      question: input.question,
    },
  };
}

export const stepsV1Capability: JudgeCapabilityRunner = { manifest, run };
