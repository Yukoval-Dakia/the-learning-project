import { z } from 'zod';
import { CrisisReferralWireSchema } from '@/core/crisis/referral';
import { ActivateEvaluationIntent } from '@/core/schema/assessment';
import { MAX_HINT_COUNT, MAX_HINT_INDEX } from '@/core/schema/event/known';
import { CreateSubmissionBodySchema } from './assessment-contracts';

export const SolveSessionParamsSchema = z.object({ sid: z.string().trim().min(1) });
export const QuestionSolveParamsSchema = z.object({
  id: z.string().trim().min(1),
  sid: z.string().trim().min(1),
});

export const StartSolveBodySchema = z
  .object({ issuance_id: z.string().min(1).optional() })
  .strict()
  .nullable();
export const CreateSolveSessionBodySchema = z
  .object({
    question_id: z.string().trim().min(1),
    issuance_id: z.string().min(1).optional(),
  })
  .strict();
export const SolveSessionCreatedSchema = z.object({
  session_id: z.string(),
  issuance_id: z.string(),
  evaluation_group_id: z.string().optional(),
  idempotency_key: z.string().optional(),
});

export const SolveSessionResponseSchema = z
  .object({
    id: z.string(),
    type: z.literal('tutor'),
    status: z.string(),
    question_id: z.string().nullable(),
  })
  .passthrough();

export const HintRequestBodySchema = z
  .object({
    hint_index: z.number().int().min(0).max(MAX_HINT_INDEX).default(0),
    issuance_id: z.string().min(1).optional(),
  })
  .nullable();
export const CreateHintRequestBodySchema = z.object({
  question_id: z.string().trim().min(1),
  hint_index: z.number().int().min(0).max(MAX_HINT_INDEX).optional(),
  issuance_id: z.string().min(1).optional(),
});
// generation failures resolve to typed degraded states instead
// of a 502. Success keeps the original {hint_request_id, text_md} shape.
export const HintFallbackReasonSchema = z.enum([
  'timeout',
  'provider_error',
  'quota',
  'bad_gateway',
  'parse_failed',
  'media_unavailable',
  'unknown',
]);
export const HintStopRetrySchema = z.object({
  retry: z.literal('stop'),
  guidance: z.string().min(1),
});
export const HintFallbackHelpSchema = z.object({
  kind: z.enum(['reference', 'deterministic_next_step']),
  source: z.enum([
    'frozen_revision_solution',
    'frozen_scoring_basis',
    'legacy_reference_md',
    'deterministic',
  ]),
  text_md: z.string().min(1),
  generated_on_demand: z.literal(false),
  disclosure_md: z.string().optional(),
});
export const HintRequestResponseSchema = z.union([
  z.object({
    hint_request_id: z.string(),
    text_md: z.string(),
  }),
  z.object({
    hint_request_id: z.string(),
    status: z.literal('fallback'),
    reason: HintFallbackReasonSchema,
    help: HintFallbackHelpSchema,
    /** Legacy {text_md} clients: preface + help.text_md for the deterministic step (help.text_md alone for a reference), so old readers still see it is not an AI hint. */
    text_md: z.string(),
    reference_available: z.boolean(),
    reference_revealed: z.boolean(),
    elapsed_ms: z.number().int().nonnegative(),
    stop_retry: HintStopRetrySchema.optional(),
  }),
  z.object({
    hint_request_id: z.string(),
    status: z.literal('unavailable'),
    reason: HintFallbackReasonSchema,
    options: z.array(z.enum(['retry', 'skip'])),
    /** Honest dead-end message — keeps the pre-union {text_md} client shape working. */
    text_md: z.string(),
    elapsed_ms: z.number().int().nonnegative(),
    stop_retry: HintStopRetrySchema.optional(),
  }),
]);

export const SolveSubmissionBodySchema = z.object({
  assessment: CreateSubmissionBodySchema.optional(),
  activation_intent: ActivateEvaluationIntent.optional(),
  self_report: z.boolean().optional(),
  user_rating: z.enum(['again', 'hard', 'good']).optional(),
  student_text_steps: z.array(z.string()).optional(),
  student_final_answer_text: z.string().optional(),
  student_image_refs: z.array(z.string()).optional(),
  hints_used: z.number().int().nonnegative().max(MAX_HINT_COUNT).optional(),
  final_hint_level: z.number().int().nonnegative().max(MAX_HINT_INDEX).optional(),
});
export const CreateSolveSubmissionBodySchema = SolveSubmissionBodySchema.extend({
  question_id: z.string().trim().min(1),
});
export const SolveSubmissionResponseSchema = z
  .object({
    attempt_event_id: z.string(),
    judge: z.unknown().optional(),
    revealed_solution_md: z.string().nullable(),
    mistake_id: z.string().optional(),
    crisis_referral: CrisisReferralWireSchema.optional(),
  })
  .passthrough();
