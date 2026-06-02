import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { z } from 'zod';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

// ----------------------------------------------------------------------------
// Schemas — input from judge runner, LLM output.
// Runtime execution lives in src/server/ai/judges/multimodal-direct-judge.ts and
// is reached through src/server/judge/invoker.ts. Shapes follow spec
// docs/superpowers/specs/2026-06-02-multimodal-direct-judge-design.md §3.
//
// multimodal_direct owns HOLISTIC, no-step-rubric vision judging (physics calc
// with a diagram; short-answer with a figure and no reference_solution). steps@1
// owns step/rubric-weighted vision judging for math derivation — the two are
// disjoint by route (see question-contract.ts §2 gating: the auto-route only
// fires when there is NO reference_solution, so steps@1 keeps its derivations).
// ----------------------------------------------------------------------------

/**
 * Judge runner input — what the server-side multimodal runner validates before
 * it composes a JudgeResultV2. The holistic judge needs only the prompt, an
 * optional reference, and whether any image is present (prompt figure or student
 * answer photo). No expected_signals / step_weight — that's the steps@1 contract.
 */
export const MultimodalDirectInput = z.object({
  prompt_md: z.string().min(1),
  reference_md: z.string().nullable(),
  image_present: z.boolean(),
});
export type MultimodalDirectInputT = z.infer<typeof MultimodalDirectInput>;

/**
 * LLM structured output schema — what the vision LLM returns, parsed and
 * validated before composing JudgeResultV2.
 */
export const MultimodalDirectLlmOutput = z.object({
  coarse_outcome: z.enum(['correct', 'partial', 'incorrect']),
  score: z.number().min(0).max(1),
  feedback_md: z.string().min(1),
  evidence: z.object({
    observed_md: z.string(),
    matched_points: z.array(z.string()).default([]),
    missing_points: z.array(z.string()).default([]),
  }),
  confidence: z.number().min(0).max(1),
});
export type MultimodalDirectLlmOutputT = z.infer<typeof MultimodalDirectLlmOutput>;

// ----------------------------------------------------------------------------
// Manifest + core registry fallback.
// ----------------------------------------------------------------------------

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'multimodal_direct',
  kind: 'judge',
  version: VERSION,
  input_schema: 'MultimodalDirectInput',
  output_schema: 'JudgeResultV2 (score_meaning=correctness)',
  // Vision LLM call; far above local exact / keyword.
  cost_class: 'expensive_llm',
  // Vision LLM call is sync from the runner's POV (awaited inside runner).
  latency_class: 'sync',
  stability: 'experimental',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

/**
 * Core registry fallback. multimodal_direct needs DB access and image loading,
 * so runtime judging must go through JudgeInvoker -> runMultimodalDirectJudge.
 * Keeping this fallback unsupported prevents callers from accidentally bypassing
 * the server runtime boundary while still allowing profile validation to resolve
 * the capability. Mirrors steps.ts run() fallback.
 */
function run(input: JudgeRunInput): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'correctness',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md:
      'multimodal_direct requires server JudgeInvoker runtime context. Use src/server/judge/invoker.ts.',
    evidence_json: {
      reason: 'server_runtime_required',
      question: input.question,
    },
  };
}

export const multimodalDirectV1Capability: JudgeCapabilityRunner = { manifest, run };
