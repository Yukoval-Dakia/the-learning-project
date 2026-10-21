import { z } from 'zod';
import { ActivityKind } from './activity';

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
  // ADR-0014 §5 — which ActivityKinds a scheduler capability
  // serves. Optional + omitted for judge/renderer capabilities (they dispatch
  // per question, not per activity-kind). The `fsrs` scheduler declares
  // ['question', 'question_part']; validateProfile checks default_policy resolves
  // to a scheduler that supports 'question'.
  supports_activity_kinds: z.array(ActivityKind).optional(),
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
  // steps@1 capability score meaning.
  // score = step_weight × Σ verdict_weight / N + (1 − step_weight) × (final_answer_match ? 1 : 0)
  // See docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md §7.4.
  'steps_v1_weighted',
  'unit_dimension_v1',
]);
export type ScoreMeaningT = z.infer<typeof ScoreMeaning>;

export const CoarseOutcome = z.enum([
  'correct',
  'partial',
  'incorrect',
  'unsupported',
  'partial_unknown',
]);
export type CoarseOutcomeT = z.infer<typeof CoarseOutcome>;

const JudgeResultV2Base = z.object({
  score_meaning: ScoreMeaning,
  confidence: z.number().min(0).max(1),
  capability_ref: CapabilityRef,
  feedback_md: z.string(),
  evidence_json: z.record(z.string(), z.unknown()),
});

export const PartialUnknownJudgeResult = JudgeResultV2Base.extend({
  coarse_outcome: z.literal('partial_unknown'),
  score: z.null(),
  feedback_md: z.string().min(1),
  partial_units: z
    .array(
      z.object({
        scoring_unit_id: z.string().min(1),
        correct_count: z.number().int().min(0),
        total_count: z.number().int().min(1),
      }),
    )
    .min(1),
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
  PartialUnknownJudgeResult,
]);
export type JudgeResultV2T = z.infer<typeof JudgeResultV2>;
