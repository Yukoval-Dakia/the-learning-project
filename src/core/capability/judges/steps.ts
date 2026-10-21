import { z } from 'zod';
import { RubricReferenceSolution as StepsReferenceSolution } from '@/core/schema/business';
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

// Schemas only; runtime judging goes through the practice-owned invoker.

export type { RubricReferenceSolutionT as StepsReferenceSolutionT } from '@/core/schema/business';
/**
 * Reference solution from the question's rubric_json; re-exported under the
 * capability-layer name. Both names are the same Zod instance.
 */
export { RubricReferenceSolution as StepsReferenceSolution } from '@/core/schema/business';

/** Input validated before composing a weighted result. */
export const StepsJudgeInput = z.object({
  prompt_md: z.string().min(1),
  reference_solution: StepsReferenceSolution,
  student_image_refs: z.array(z.string().min(1)).default([]),
  student_text_steps: z.array(z.string().min(1)).optional(),
  student_final_answer_text: z.string().optional(),
  // score = step_weight × weighted step verdicts + (1 - step_weight) × final match
  step_weight: z.number().min(0).max(1),
});
export type StepsJudgeInputT = z.infer<typeof StepsJudgeInput>;

/** Parsed and validated before composing the result. */
export const StepsLlmOutput = z.object({
  extracted_steps: z.array(
    z.object({
      idx: z.number().int().min(0),
      content: z.string().min(1),
      verdict: z.enum(['correct', 'partial', 'wrong', 'skipped']),
      comment: z.string(),
    }),
  ),
  // Transcribed for evidence; partial credit does not depend on it.
  extracted_final_answer: z.string(),
  // Aligns one-to-one with reference_solution.expected_signals; the runner checks length.
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

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'steps',
  kind: 'judge',
  version: VERSION,
  input_schema: 'StepsJudgeInput',
  output_schema: 'JudgeResultV2 (score_meaning=steps_v1_weighted)',
  cost_class: 'expensive_llm',
  latency_class: 'sync',
  stability: 'experimental',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

/** Unsupported by design: runtime needs DB/image access through JudgeInvoker. */
function run(input: JudgeRunInput): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'steps_v1_weighted',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md:
      'steps@1 requires server JudgeInvoker runtime context. Use the Practice judge invoker.',
    evidence_json: {
      reason: 'server_runtime_required',
      question: input.question,
    },
  };
}

export const stepsV1Capability: JudgeCapabilityRunner = { manifest, run };
