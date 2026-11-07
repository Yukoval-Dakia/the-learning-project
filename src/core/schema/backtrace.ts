import { z } from 'zod';

export const ATTEMPT_INSIGHT_VERSION = 'attempt-insight-v2';
export const BACKTRACE_JUDGE_VERSION = 'backtrace-judge-v2';

const MethodCore = z
  .object({ core_idea_md: z.string().max(200), key_step_md: z.string().max(200) })
  .strict();
export const AttemptDescription = z
  .object({
    method: MethodCore.extend({
      provenance: z.enum(['evidence', 'inferred']),
      evidence_quotes: z.array(z.string().min(1).max(200)).max(8),
      steps: z
        .array(
          z
            .object({
              k: z.string().max(32),
              text_md: z.string().max(160),
              quote: z.string().max(200).optional(),
              quote_verified: z.boolean(),
            })
            .strict(),
        )
        .max(8),
    }).nullable(),
    needed_method: MethodCore.nullable(),
    mechanism: z
      .object({
        what_went_wrong_md: z.string().max(300),
        trigger_md: z.string().max(160),
        wrong_step_k: z.string().max(32).optional(),
        quote: z.string().max(200).optional(),
        quote_verified: z.boolean(),
      })
      .strict()
      .nullable(),
    no_description_reason: z.string().max(160).nullable(),
  })
  .strict();
export const BacktraceDecisions = z
  .object({
    matches: z
      .array(
        z
          .object({
            attempt_event_id: z.string(),
            relation: z.enum(['same_mechanism', 'same_method', 'needs_this_method', 'not_similar']),
            specificity: z.enum(['specific', 'broad']),
            shared_step: z.object({ now_k: z.string(), then_k: z.string() }).strict().nullable(),
            why_md: z.string().max(160),
            outcome: z.enum(['success', 'partial', 'failure']),
            evidence: z
              .object({ now: z.string().min(1).max(200), prior: z.string().min(1).max(200) })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export const InsightPayload = AttemptDescription.extend({
  insight_version: z.literal(ATTEMPT_INSIGHT_VERSION),
  question_id: z.string(),
  input_digest: z.string(),
  source_event_ids: z.array(z.string()),
  verdict_seen: z
    .object({
      outcome: z.enum(['success', 'partial', 'failure']),
      judge_event_id: z.string().nullable(),
      evaluation_id: z.string().nullable(),
    })
    .strict(),
  user_cause_event_id: z.string().nullable(),
  image_status: z.enum(['none', 'text_available', 'unavailable']),
  backfill_run_id: z.string().optional(),
}).strict();
export const JudgementPayload = BacktraceDecisions.extend({
  judgement_version: z.literal(BACKTRACE_JUDGE_VERSION),
  pool_digest: z.string(),
  anchor_insight_id: z.string(),
  source_event_ids: z.array(z.string()),
}).strict();
export type Insight = z.infer<typeof InsightPayload>;
export type Description = z.infer<typeof AttemptDescription>;
const BacktraceRow = z.object({
  question_id: z.string(),
  answer_md: z.string(),
  attempt_event_id: z.string(),
  created_at: z.string(),
  outcome: z.enum(['success', 'partial', 'failure']),
  insight: InsightPayload.nullable(),
});
const MatchRow = BacktraceRow.extend({
  insight: InsightPayload,
  question_id: z.string(),
  prompt_snippet: z.string().nullable(),
  answer_md: z.string(),
  relation: BacktraceDecisions.shape.matches.element.shape.relation,
  specificity: z.enum(['specific', 'broad']),
  shared_step: z.object({ now_k: z.string(), then_k: z.string() }).nullable(),
  why_md: z.string(),
  evidence: BacktraceDecisions.shape.matches.element.shape.evidence,
  signals: z.object({
    basis: z.literal('same_question_history'),
    count: z.number(),
    last_seen_at: z.string(),
    fixed_later: z.boolean(),
    error_rate: z.number(),
    sim: z.number(),
    generic: z.number(),
  }),
  score: z.number(),
});
export const BacktraceView = z.object({
  status: z.enum([
    'unavailable',
    'buffered',
    'pending_insight',
    'judging',
    'ready',
    'needs_reconciliation',
    'failed',
  ]),
  failure: z.object({ reason_md: z.string(), cost_upper_usd: z.number().nullable() }).optional(),
  anchor: z
    .object({
      attempt_event_id: z.string(),
      question_id: z.string(),
      outcome: z.enum(['success', 'partial', 'failure']),
      insight: InsightPayload.optional(),
    })
    .nullable(),
  same_question: z.array(BacktraceRow),
  similar_mistakes: z.array(MatchRow),
  similar_solutions: z.array(MatchRow),
  broader: z.array(MatchRow),
  judgement: z
    .object({ event_id: z.string(), task_run_id: z.string().nullable(), judged_at: z.string() })
    .nullable(),
});
