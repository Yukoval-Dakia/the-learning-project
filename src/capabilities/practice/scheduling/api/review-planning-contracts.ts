import { z } from 'zod';
import { CrisisReferralWireSchema } from '@/core/crisis/referral';
import { ActivateEvaluationIntent } from '@/core/schema/assessment';
import {
  ActivityRef,
  CauseCategory,
  FsrsRating,
  GradingProvenanceEntry,
  PartialUnknownJudgeResult,
  ScoreMeaning,
} from '@/kernel/capability-contract-schemas';
import { ApiErrorResponseSchema } from '@/kernel/http-contracts';
import { CreateSubmissionBodySchema } from '../../api/assessment-contracts';
import {
  AttemptCorrectionStateSchema,
  CreateAttemptCaptureSchema,
  FormalAttemptResponseSchema,
  FsrsStateWireSchema,
} from '../../api/contracts';

// The handlers deliberately accept parseInt-compatible strings (for example,
// `20items` currently means 20). Keep that compatibility visible instead of
// advertising stricter numeric coercion than the runtime implements.
export const ReviewDueQuerySchema = z.object({
  limit: z.string().optional(),
});

export const ReviewDueResponseSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      activity_ref: ActivityRef,
      question_id: z.string(),
      fsrs_subject_kind: z.enum(['question', 'knowledge']),
      fsrs_subject_id: z.string(),
      prompt_md: z.string(),
      reference_md: z.string().nullable(),
      knowledge_ids: z.array(z.string()),
      cause: CauseCategory.nullable(),
      fsrs_state: FsrsStateWireSchema.nullable(),
      created_at: z.string().datetime(),
      last_failure_event: z
        .object({
          id: z.string(),
          correction_state: AttemptCorrectionStateSchema,
        })
        .nullable(),
    }),
  ),
});

export const ReviewAdviceBodySchema = z.object({
  assessment: CreateSubmissionBodySchema,
  activity_ref: ActivityRef.optional(),
  question_id: z.string().min(1).optional(),
  mistake_id: z.string().min(1).optional(),
  response_md: z.string().default(''),
  // 附件证据（手写/拍照）随 advice 预览一并交给 judge，与提交契约
  // CreateAttemptBodySchema.answer_image_refs 同口径。OPTIONAL（default []）：省略即字段
  // 存在但为空，纯文本 advice 的判分路径 / wire 逐字不变；有值时 preview 与 committed
  // submit 看到同一份附件（否则预览判词与实际提交判词分叉）。
  answer_image_refs: z.array(z.string()).default([]),
  // Present = the caller hands over this attempt's commit capture, so an automatic verdict is
  // recorded and settled in this request. Absent = preview only; the caller commits separately.
  commit: CreateAttemptCaptureSchema.optional(),
  accept_pending: z.boolean().optional(),
});

const LegacyReviewAdviceJudgeSchema = z.object({
  route: z.string(),
  score: z.number().nullable(),
  score_meaning: ScoreMeaning,
  coarse_outcome: z.enum(['correct', 'partial', 'incorrect', 'unsupported']),
  confidence: z.number().min(0).max(1),
  feedback_md: z.string(),
  evidence_json: z.record(z.string(), z.unknown()),
  capability_ref: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  grading_provenance: z.array(GradingProvenanceEntry).optional(),
  suggested_rating: FsrsRating.nullable(),
  telemetry: z.unknown().optional(),
  // advice.ts returns these so the client can echo them back on submit
  // for the supplied-verified provenance path. Optional: present only for a
  // model-invoked route with a run id and a configured signing secret.
  task_run_id: z.string().optional(),
  provenance_token: z.string().optional(),
});

const ReviewAdviceJudgeSchema = z.discriminatedUnion('coarse_outcome', [
  LegacyReviewAdviceJudgeSchema,
  LegacyReviewAdviceJudgeSchema.omit({ coarse_outcome: true, score: true }).extend(
    PartialUnknownJudgeResult.pick({ coarse_outcome: true, score: true, partial_units: true })
      .shape,
  ),
]);

export const ReviewAdviceResponseSchema = z.object({
  activity_ref: ActivityRef,
  question_id: z.string(),
  submission_id: z.string(),
  evaluation_group_id: z.string(),
  candidate_id: z.string(),
  activation_intent: ActivateEvaluationIntent,
  automatic_commit: z.boolean(),
  judge: ReviewAdviceJudgeSchema,
  advice: z.object({
    rating: FsrsRating.nullable(),
    reason: z.string(),
    evidence_score: z.number().nullable(),
  }),
  // The createAttempt body of the attempt this request committed (see `commit`).
  committed: FormalAttemptResponseSchema.optional(),
  // Deterministic lexical classification of the same text the write point persists —
  // present in the 200 preview regardless of the durable switch; absent on ordinary answers.
  crisis_referral: CrisisReferralWireSchema.optional(),
});

// The advice route classifies before any model call and folds the referral into
// error details, so only its error responses declare the field — declared
// locally to keep the shared ApiError component inline-cheap everywhere else.
export const AdviceErrorResponseSchema = ApiErrorResponseSchema.extend({
  details: z
    .object({
      crisis_referral: CrisisReferralWireSchema.optional(),
    })
    .passthrough()
    .optional(),
});
export const ADVICE_ERROR_RESPONSES = {
  400: AdviceErrorResponseSchema,
  401: AdviceErrorResponseSchema,
  404: AdviceErrorResponseSchema,
  409: AdviceErrorResponseSchema,
  422: AdviceErrorResponseSchema,
  429: AdviceErrorResponseSchema,
  500: AdviceErrorResponseSchema,
} as const;

export const ReviewWeeklyQuerySchema = z.object({
  days: z.string().optional(),
  timezone: z.string().optional(),
});

export const ReviewWeeklyResponseSchema = z.object({
  window: z.object({
    days: z.number().int().min(1).max(90),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    time_zone: z.string(),
  }),
  totals: z.object({
    reviews: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative(),
  }),
  ratings: z.object({
    again: z.number().int().nonnegative(),
    hard: z.number().int().nonnegative(),
    good: z.number().int().nonnegative(),
    easy: z.number().int().nonnegative(),
  }),
  daily: z.array(
    z.object({
      date: z.string(),
      count: z.number().int().nonnegative(),
      correct: z.number().int().nonnegative(),
      incorrect: z.number().int().nonnegative(),
      partial: z.number().int().nonnegative(),
      ungraded: z.number().int().nonnegative(),
    }),
  ),
  top_causes: z.array(
    z.object({
      category: CauseCategory,
      // misc_ category id 的显示回填（active misconception title）；
      // 非 misc / unresolvable → null，渲染层回退 category 裸 id。
      category_label: z.string().nullable(),
      count: z.number().int().positive(),
    }),
  ),
  top_knowledge: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      failure_count: z.number().int().positive(),
    }),
  ),
});
