import { z } from 'zod';
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { ConjectureProbeSignatureMatch } from '@/core/schema/conjecture-probe-response';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

// Schemas only; runtime judging goes through the practice-owned invoker.
//
// This judge owns holistic vision judging without a step rubric. steps@1 owns
// rubric-weighted derivations; routing keeps the two disjoint.

/** Holistic input: no expected signals or step weight, which belong to steps@1. */
export const MultimodalDirectInput = z.object({
  prompt_md: z.string().min(1),
  reference_md: z.string().nullable(),
  image_present: z.boolean(),
});
export type MultimodalDirectInputT = z.infer<typeof MultimodalDirectInput>;

/** Parsed and validated before composing the result. */
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
  // Produced by the same call as correctness, avoiding a second paid call and a
  // divergent interpretation.
  probe_signature_match: ConjectureProbeSignatureMatch.optional(),
});
export type MultimodalDirectLlmOutputT = z.infer<typeof MultimodalDirectLlmOutput>;

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'multimodal_direct',
  kind: 'judge',
  version: VERSION,
  input_schema: 'MultimodalDirectInput',
  output_schema: 'JudgeResultV2 (score_meaning=correctness)',
  cost_class: 'expensive_llm',
  latency_class: 'sync',
  stability: 'experimental',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

/** Unsupported by design: runtime needs DB/image access through JudgeInvoker. */
function run(input: JudgeRunInput): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'correctness',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md:
      'multimodal_direct requires server JudgeInvoker runtime context. Use the Practice judge invoker.',
    evidence_json: {
      reason: 'server_runtime_required',
      question: input.question,
    },
  };
}

export const multimodalDirectV1Capability: JudgeCapabilityRunner = { manifest, run };
