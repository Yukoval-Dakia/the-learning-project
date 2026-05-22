import { z } from 'zod';

export const CapabilityKind = z.enum(['judge', 'renderer', 'scheduler']);
export type CapabilityKindT = z.infer<typeof CapabilityKind>;

export const CostClass = z.enum(['local', 'cheap_llm', 'expensive_llm', 'external']);
export type CostClassT = z.infer<typeof CostClass>;

export const LatencyClass = z.enum(['sync', 'async']);
export type LatencyClassT = z.infer<typeof LatencyClass>;

export const Stability = z.enum(['experimental', 'stable', 'deprecated']);
export type StabilityT = z.infer<typeof Stability>;

export const CapabilityManifest = z.object({
  id: z.string().min(1),
  kind: CapabilityKind,
  version: z.string().min(1),
  input_schema: z.string().min(1),
  output_schema: z.string().min(1),
  cost_class: CostClass,
  latency_class: LatencyClass,
  stability: Stability,
  replaced_by: z.string().optional(),
});
export type CapabilityManifestT = z.infer<typeof CapabilityManifest>;

export const CapabilityRef = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
});
export type CapabilityRefT = z.infer<typeof CapabilityRef>;

export const CapabilityRunRef = z.object({
  capability: CapabilityRef,
  input_schema_version: z.string().min(1),
  output_schema_version: z.string().min(1),
  config_hash: z.string().min(1),
  prompt_version: z.string().optional(),
  model_ref: z.string().optional(),
});
export type CapabilityRunRefT = z.infer<typeof CapabilityRunRef>;

export const ScoreMeaning = z.enum([
  'correctness',
  'mastery_estimate',
  'rubric_weighted',
  'external_verdict',
  // M2.1 (2026-05-22): steps@1 capability score meaning.
  // score = step_weight × Σ verdict_weight / N + (1 − step_weight) × (final_answer_match ? 1 : 0)
  // See docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md §7.4.
  'steps_v1_weighted',
]);
export type ScoreMeaningT = z.infer<typeof ScoreMeaning>;

export const CoarseOutcome = z.enum(['correct', 'partial', 'incorrect', 'unsupported']);
export type CoarseOutcomeT = z.infer<typeof CoarseOutcome>;

const JudgeResultV2Base = z.object({
  score_meaning: ScoreMeaning,
  confidence: z.number().min(0).max(1),
  capability_ref: CapabilityRef,
  feedback_md: z.string(),
  evidence_json: z.record(z.string(), z.unknown()),
});

export const JudgeResultV2 = z.discriminatedUnion('coarse_outcome', [
  JudgeResultV2Base.extend({
    coarse_outcome: z.literal('correct'),
    score: z.number().min(0.85).max(1),
  }),
  JudgeResultV2Base.extend({
    coarse_outcome: z.literal('partial'),
    score: z.number().gt(0).lt(0.85),
    feedback_md: z.string().min(1),
  }),
  JudgeResultV2Base.extend({
    coarse_outcome: z.literal('incorrect'),
    score: z.literal(0),
    feedback_md: z.string().min(1),
  }),
  JudgeResultV2Base.extend({
    coarse_outcome: z.literal('unsupported'),
    score: z.null(),
    confidence: z.literal(0),
    feedback_md: z.string().min(1),
  }),
]);
export type JudgeResultV2T = z.infer<typeof JudgeResultV2>;
