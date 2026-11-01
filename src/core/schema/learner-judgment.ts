import { z } from 'zod';
import { MASTERY_BAND_THRESHOLDS } from '@/core/mastery-band';
import type { MasteryDecayBucket } from '@/core/mastery-freshness';
import { RetentionReadingSchema } from './scheduling-state';

// v0 only reads the incumbent's skill-wide state. No arbitrary signal bag or
// learner attributes: unsupported contexts and additional input keys are rejected.
export const LearnerJudgmentInputSchema = z.strictObject({
  knowledge_ids: z.array(z.string().trim().min(1)),
  context: z.literal('any'),
  // Retention evaluation time, NOT a historical database cutoff or input watermark.
  as_of: z.date(),
});
export type LearnerJudgmentInput = z.infer<typeof LearnerJudgmentInputSchema>;

const UnknownSchema = z.object({ kind: z.literal('unknown'), reason: z.string() });
export type JudgmentUnknown = z.infer<typeof UnknownSchema>;

// Exactly the existing mastery getter's reading, including its legacy band and
// KG provenance. The band is not a new personally calibrated prediction interval.
const IncumbentMasteryReadingSchema = z.object({
  mastery: z.number(),
  mastery_lo: z.number(),
  mastery_hi: z.number(),
  low_confidence: z.boolean(),
  theta_hat: z.number(),
  theta_precision: z.number(),
  theta_se: z.number(),
  evidence_count: z.number(),
  success_count: z.number(),
  fail_count: z.number(),
  last_outcome_at: z.date().nullable(),
  beta: z.number(),
  provenance: z.enum(['observed', 'inferred']),
  theta_hat_raw: z.number().optional(),
});

const AbilitySchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({ kind: z.literal('available'), reading: IncumbentMasteryReadingSchema }),
]);
const RetentionSchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({
    kind: z.literal('available'),
    // The port's number is FSRS; a structured score is the candidate. Unknown
    // readings do not establish the actual engine, even when a flag is selected.
    engine: z.enum(['fsrs', 'forgetting_candidate', 'unknown']),
    reading: RetentionReadingSchema,
  }),
]);

// Registered engineering priors for the disagreement reading, reusing the mastery
// band vocabulary (>= solid is the high side, < growing is the low side). A
// disagreement verdict compares the two already-published component readings at
// these thresholds; it is NOT a joint prediction and stays uncalibrated.
export const COMPONENT_DISAGREEMENT_RULE = {
  high: MASTERY_BAND_THRESHOLDS.solid,
  low: MASTERY_BAND_THRESHOLDS.growing,
} as const;

// 「不会」vs「不知道你会不会」. The low side is the disagreement rule's existing
// threshold, not a new calibrated cut. A prior or a neighbour is not low ability.
export const AbilityClaimSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('low_observed'),
    rule: z.object({ low: z.number() }),
    calibration: z.literal('uncalibrated'),
  }),
  z.object({
    kind: z.literal('observed'),
    rule: z.object({ low: z.number() }),
    calibration: z.literal('uncalibrated'),
  }),
  z.object({
    kind: z.literal('insufficient_evidence'),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('not_evaluable'),
    reason: z.literal('knowledge_role_not_mastery_evaluable'),
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.string(),
  }),
]);
export type AbilityClaim = z.infer<typeof AbilityClaimSchema>;

// Marks whether uncertainty is growing as evidence ages. Uses the existing
// freshness buckets; does not widen a numeric interval. Recall intervals are
// not this field — the retention reading has no review timestamp to age.
export const EvidenceAgeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('not_applicable'),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('undated'),
    reason: z.literal('observed_evidence_without_timestamp'),
  }),
  z.object({
    kind: z.literal('dated'),
    idle_days: z.number().int().nonnegative(),
    freshness: z.enum(['fresh', 'mild', 'stale']),
    growing: z.boolean(),
  }),
]);
export type EvidenceAge = z.infer<typeof EvidenceAgeSchema>;

export const ComponentDisagreementSchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({
    kind: z.literal('divergence_observed'),
    direction: z.enum(['ability_high_retention_low', 'ability_low_retention_high']),
    rule: z.object({ high: z.number(), low: z.number() }),
    calibration: z.literal('uncalibrated'),
  }),
  z.object({
    kind: z.literal('no_divergence_observed'),
    rule: z.object({ high: z.number(), low: z.number() }),
    calibration: z.literal('uncalibrated'),
  }),
  // One side has no usable reading, so the two observables cannot be compared.
  z.object({
    kind: z.literal('partial_coverage'),
    missing: z.enum(['ability', 'retention']),
    reason: z.string(),
  }),
]);

const DECAY_BUCKETS = [
  'untrained',
  'fresh',
  'mild',
  'stale',
  'unknown',
] as const satisfies readonly MasteryDecayBucket[];
const DecayBucketSchema = z.enum(DECAY_BUCKETS);

// Incumbent R(t) is a point from population or engineering parameters.
// No personal interval exists until calibration; do not invent one.
const UncalibratedRecallIntervalSchema = z.object({
  kind: z.literal('not_estimated'),
  calibration: z.literal('uncalibrated'),
});

export const ReviewRecallSchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({
    kind: z.literal('point'),
    value: z.number().min(0).max(1),
    interval: UncalibratedRecallIntervalSchema,
    calibration: z.literal('uncalibrated'),
    engine: z.enum(['fsrs', 'forgetting_candidate']),
  }),
]);

const ReviewDurationSchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({
    kind: z.literal('known'),
    duration_ms: z.number().int().nonnegative(),
  }),
]);

const ReviewInstantSchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({ kind: z.literal('known'), at: z.date() }),
]);
const ReviewDueSchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({ kind: z.literal('known'), at: z.date() }),
  z.object({ kind: z.literal('absent') }),
]);

// Shelf of a 精熟 ability band or a retention point at that same display cut.
// The shelf is the existing decay bucket plus due, not a new half-life.
const MasteredShelfSchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({ kind: z.literal('not_high') }),
  z.object({
    kind: z.literal('shelf'),
    decay_bucket: DecayBucketSchema,
    due_at: ReviewDueSchema,
  }),
]);

export const ReviewTimingSchema = z.object({
  recall: ReviewRecallSchema,
  basis: z.object({
    last_retrieval_at: ReviewInstantSchema,
    duration_ms: ReviewDurationSchema,
  }),
  freshness: z.object({
    decay_bucket: DecayBucketSchema,
    due_at: ReviewDueSchema,
    mastered_shelf: MasteredShelfSchema,
  }),
});
export type ReviewTiming = z.infer<typeof ReviewTimingSchema>;

const ReviewInstantJsonSchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({ kind: z.literal('known'), at: z.string() }),
]);
const ReviewDueJsonSchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({ kind: z.literal('known'), at: z.string() }),
  z.object({ kind: z.literal('absent') }),
]);
const MasteredShelfJsonSchema = z.discriminatedUnion('kind', [
  UnknownSchema,
  z.object({ kind: z.literal('not_high') }),
  z.object({
    kind: z.literal('shelf'),
    decay_bucket: DecayBucketSchema,
    due_at: ReviewDueJsonSchema,
  }),
]);

export const ReviewTimingJsonSchema = z.object({
  recall: ReviewRecallSchema,
  basis: z.object({
    last_retrieval_at: ReviewInstantJsonSchema,
    duration_ms: ReviewDurationSchema,
  }),
  freshness: z.object({
    decay_bucket: DecayBucketSchema,
    due_at: ReviewDueJsonSchema,
    mastered_shelf: MasteredShelfJsonSchema,
  }),
});
export type ReviewTimingJson = z.infer<typeof ReviewTimingJsonSchema>;

export const LearnerJudgmentSchema = z.object({
  knowledge_id: z.string(),
  ability: AbilitySchema,
  p_correct_now: z.discriminatedUnion('kind', [
    UnknownSchema,
    z.object({
      kind: z.literal('incumbent_pfa'),
      value: z.number(),
      band: z.object({
        kind: z.literal('incumbent_mastery_band'),
        lo: z.number(),
        hi: z.number(),
      }),
      calibration: z.literal('uncalibrated'),
    }),
  ]),
  ability_claim: AbilityClaimSchema,
  retention: RetentionSchema,
  review_timing: ReviewTimingSchema,
  retention_forecast: UnknownSchema,
  uncertainty: z.object({
    independent_evidence: UnknownSchema,
    helped_evidence: UnknownSchema,
    self_rated_evidence: UnknownSchema,
    component_disagreement: ComponentDisagreementSchema,
    evidence_age: EvidenceAgeSchema,
  }),
  would_change_it: UnknownSchema,
  patterns: UnknownSchema,
  corrections: UnknownSchema,
  judgement: z.string(),
});
export type LearnerJudgment = z.infer<typeof LearnerJudgmentSchema>;

export const LearnerJudgmentBatchSchema = z.object({
  version: z.literal('v0-incumbent'),
  calibration: z.literal('uncalibrated'),
  context: z.literal('any'),
  as_of: z.date(),
  consistency: z.discriminatedUnion('kind', [
    UnknownSchema,
    z.object({
      kind: z.literal('snapshot'),
      isolation: z.enum(['repeatable read', 'serializable']),
      access: z.literal('read only'),
    }),
  ]),
  components: z.object({
    ability: z.object({
      source: z.literal('kernel/read-models/mastery-projection:getMasteryProjection'),
      version: UnknownSchema,
      input_high_water: UnknownSchema,
    }),
    retention: z.object({
      source: z.literal('kernel/scheduling:retrievabilityForKc'),
      selected_engine: z.discriminatedUnion('kind', [
        UnknownSchema,
        z.object({
          kind: z.literal('selected'),
          engine: z.enum(['fsrs', 'forgetting_candidate']),
        }),
      ]),
      version: UnknownSchema,
      input_high_water: UnknownSchema,
    }),
  }),
  // Neither source getter exposes a complete event sequence/digest. In
  // particular last_outcome_at and the evaluation time cannot stand in for it.
  input_high_water: UnknownSchema,
  calibration_evidence: UnknownSchema,
  sealing: z.literal('not_connected'),
  items: z.array(LearnerJudgmentSchema),
});
export type LearnerJudgmentBatch = z.infer<typeof LearnerJudgmentBatchSchema>;
