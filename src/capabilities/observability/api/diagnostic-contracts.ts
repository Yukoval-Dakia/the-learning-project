import { z } from 'zod';
import { PROBE_RESOLUTIONS } from '@/kernel/capability-contract-schemas';

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
      resolution: z.enum(PROBE_RESOLUTIONS),
      brier_model: z.number().nullable(),
      brier_baseline: z.number().nullable(),
      log_loss_model: z.number().nullable(),
      skill_score_point: z.number().nullable(),
      retrievability_at_judge: z.number().nullable(),
      created_at: z.string().datetime(),
    }),
  ),
  typed_states: z.array(
    z.object({
      id: z.string(),
      knowledge_id: z.string(),
      typed_state: z.literal('confused-with-X'),
      confused_with_kc_id: z.string(),
      lifecycle: z.enum(['open', 'resolved']),
      evidence_event_ids: z.array(z.string()),
      last_evidence_at: z.string().datetime().nullable(),
      updated_at: z.string().datetime(),
    }),
  ),
  diagnostics: z.object({
    prediction_scores: z.object({
      scanned_count: z.number().int().nonnegative(),
      dropped_count: z.number().int().nonnegative(),
      scan_truncated: z.boolean(),
    }),
    typed_states: z.object({
      scanned_count: z.number().int().nonnegative(),
      dropped_count: z.number().int().nonnegative(),
      scan_truncated: z.boolean(),
    }),
  }),
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

const TrendSeriesSchema = z.object({
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
});

export const EffectivenessTrendResponseSchema = z.object({
  series: z.array(TrendSeriesSchema),
  subject_roots: z.array(TrendSeriesSchema),
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
  metadata: z.object({
    as_of: z.string().datetime(),
    window_start: z.string().datetime(),
    window_end: z.string().datetime(),
    timezone: z.literal('Asia/Shanghai'),
    granularity: z.literal('calendar_day'),
    notable_limit: z.literal(6),
    eligible: z.number().int().nonnegative(),
    returned: z.number().int().min(0).max(6),
    truncated: z.boolean(),
  }),
});
