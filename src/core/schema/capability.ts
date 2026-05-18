import { z } from 'zod';

export const CapabilityKind = z.enum(['judge', 'renderer', 'scheduler']);
export type CapabilityKindT = z.infer<typeof CapabilityKind>;

export const CostClass = z.enum([
  'local',
  'cheap_llm',
  'expensive_llm',
  'external',
]);
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
]);
export type ScoreMeaningT = z.infer<typeof ScoreMeaning>;

export const CoarseOutcome = z.enum([
  'correct',
  'partial',
  'incorrect',
  'unsupported',
]);
export type CoarseOutcomeT = z.infer<typeof CoarseOutcome>;

export const JudgeResultV2 = z.object({
  score: z.number().min(0).max(1),
  score_meaning: ScoreMeaning,
  coarse_outcome: CoarseOutcome,
  confidence: z.number().min(0).max(1),
  capability_ref: CapabilityRef,
  feedback_md: z.string(),
  evidence_json: z.record(z.string(), z.unknown()),
});
export type JudgeResultV2T = z.infer<typeof JudgeResultV2>;
