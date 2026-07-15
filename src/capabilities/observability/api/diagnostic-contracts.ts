import { z } from 'zod';

export const ConjectureScoresResponseSchema = z.object({
  score_basis: z.literal('single_point'),
  prediction_scores: z.array(
    z.object({
      event_id: z.string(),
      conjecture_event_id: z.string(),
      probe_result_event_id: z.string(),
      knowledge_id: z.string(),
      predicted_p: z.number(),
      baseline_p: z.number(),
      outcome: z.union([z.literal(0), z.literal(1)]),
      resolution: z.enum(['confirmed', 'retired']),
      brier_model: z.number(),
      brier_baseline: z.number(),
      log_loss_model: z.number(),
      skill_score_point: z.number(),
      retrievability_at_judge: z.number().nullable(),
      created_at: z.string().datetime(),
    }),
  ),
  typed_states: z.array(
    z.object({
      id: z.string(),
      knowledge_id: z.string(),
      typed_state: z.literal('confused-with-X'),
      confused_with_kc_id: z.string().nullable(),
      lifecycle: z.enum(['open', 'resolved']),
      evidence_event_ids: z.array(z.string()),
      last_evidence_at: z.string().datetime().nullable(),
      updated_at: z.string().datetime(),
    }),
  ),
});

const JudgeCalibrationStratumSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    n: z.number().int().nonnegative(),
    agreed: z.number().int().nonnegative(),
    bit_agreed: z.number().int().nonnegative(),
    agreement_rate: z.number(),
    bit_agreement_rate: z.number(),
  }),
  z.object({
    status: z.literal('insufficient_data'),
    n: z.number().int().nonnegative(),
  }),
]);

export const JudgeCalibrationResponseSchema = z.object({
  total_samples: z.number().int().nonnegative(),
  same_lane_suspected_count: z.number().int().nonnegative(),
  headline: JudgeCalibrationStratumSchema,
  by_route: z.record(z.string(), JudgeCalibrationStratumSchema),
  by_original_outcome: z.record(z.string(), JudgeCalibrationStratumSchema),
  recent_samples: z.array(
    z.object({
      sampled_at: z.string(),
      original_outcome: z.string(),
      rejudge_outcome: z.string(),
      agreed: z.boolean(),
      bit_agreed: z.boolean(),
      rejudge_route: z.string(),
      rejudge_provider: z.string(),
      rejudge_task_run_id: z.string().nullable(),
      same_lane_suspected: z.boolean(),
    }),
  ),
  recent_runs: z.array(
    z.object({
      at: z.string().datetime(),
      sampled: z.number().int().nonnegative(),
      agreed: z.number().int().nonnegative(),
      disagreed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      skipped_missing_input: z.number().int().nonnegative(),
      skipped_unsupported: z.number().int().nonnegative(),
      errors: z.number().int().nonnegative(),
      batch_max: z.number().int().nonnegative(),
    }),
  ),
  notes: z.array(z.string()),
});

const CoverageGapKindSchema = z.enum([
  'frontier_zero',
  'source_quality',
  'diagnostic',
  'format_diversity',
]);

const GapActivitySchema = z.object({
  lastActivityAt: z.string().datetime().nullable(),
  lastStatus: z.string().nullable(),
  lastDispatchedAt: z.string().datetime().nullable(),
  inCooldown: z.boolean(),
  cooldownUntil: z.string().datetime().nullable(),
});

const CoverageGapSchema = z.object({
  gapKind: CoverageGapKindSchema,
  kind: z.string(),
  difficultyBand: z.enum(['below', 'near', 'above', 'stretch']),
  minSourceTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  desiredCount: z.number().int().nonnegative(),
  priority: z.number(),
  reason: z.string(),
  fingerprint: z.string(),
  routePreference: z.array(
    z.enum(['author_question', 'sourcing_web', 'ingest_existing', 'image_candidate', 'quiz_gen']),
  ),
  scaffold: z.boolean(),
  lastActivity: GapActivitySchema.nullable(),
});

export const CoverageLatticeResponseSchema = z.object({
  generated_at: z.string().datetime(),
  scan_ms: z.number().nonnegative(),
  coverage_depth_threshold: z.number().int().nonnegative(),
  near_window: z.number().nonnegative(),
  cooldown_days: z.number().nonnegative(),
  scope_note: z.string(),
  subjects: z.array(
    z.object({
      subjectId: z.string(),
      displayName: z.string().nullable(),
      kcs: z.array(
        z.object({
          knowledgeId: z.string(),
          thetaHat: z.number(),
          evidenceCount: z.number().int().nonnegative(),
          usableCount: z.number().int().nonnegative(),
          depthMet: z.boolean(),
          hasHighTier: z.boolean().nullable(),
          hasNearThetaAnchor: z.boolean().nullable(),
          formatDiverse: z.boolean().nullable(),
          gapKinds: z.array(CoverageGapKindSchema),
          gaps: z.array(CoverageGapSchema),
        }),
      ),
    }),
  ),
  totals: z.object({
    activeKcs: z.number().int().nonnegative(),
    kcsWithGaps: z.number().int().nonnegative(),
    totalGaps: z.number().int().nonnegative(),
    gapsByKind: z.record(z.string(), z.number().int().nonnegative()),
  }),
});

export const CalibrationMaturityResponseSchema = z.object({
  rows: z.array(
    z.object({
      knowledge_id: z.string(),
      name: z.string(),
      evidence_count: z.number().int().nonnegative(),
      theta_se: z.number().nullable(),
      confidence: z.number().nullable(),
      track: z.string().nullable(),
      cold_start: z.boolean(),
    }),
  ),
  aggregate: z.object({
    total_kcs: z.number().int().nonnegative(),
    cold_start_count: z.number().int().nonnegative(),
    firm_count: z.number().int().nonnegative(),
    pct_firm: z.number(),
    median_theta_se: z.number().nullable(),
  }),
});

const TrendDirectionSchema = z.enum(['rising', 'holding', 'falling', 'insufficient']);
const TrendConfidenceSchema = z.enum(['low', 'medium', 'high']);
const TrendSummarySchema = z.object({
  direction: TrendDirectionSchema,
  confidence: TrendConfidenceSchema,
  span_evidence: z.number().int().nonnegative(),
  has_mastery_signal: z.boolean(),
});

export const EffectivenessTrendResponseSchema = z.object({
  series: z.array(
    z.object({
      knowledge_id: z.string(),
      name: z.string().nullable(),
      effective_domain: z.string().nullable(),
      points: z.array(
        z.object({
          at: z.string().datetime(),
          p_learned: z.number().nullable(),
          theta_hat: z.number().nullable(),
          theta_delta: z.number().nullable(),
        }),
      ),
      trend: TrendSummarySchema,
      activity_count: z.number().int().nonnegative(),
    }),
  ),
  aggregate: z.object({
    total_kcs_with_activity: z.number().int().nonnegative(),
    total_events: z.number().int().nonnegative(),
    by_subject: z.array(
      z.object({
        effective_domain: z.string().nullable(),
        direction: TrendDirectionSchema,
        confidence: TrendConfidenceSchema,
        kc_count: z.number().int().nonnegative(),
        kc_with_mastery_signal: z.number().int().nonnegative(),
        activity_count: z.number().int().nonnegative(),
      }),
    ),
  }),
});
