import { z } from 'zod';

import { REASONING_TRACE_MAX_LEN } from '@/core/schema/event/known';
import { ActivityRef, FsrsRating, JudgeResultV2 } from '@/kernel/capability-contract-schemas';

/** Bound text copied into judge prompts and immutable attempt events. */
export const MAX_REVIEW_RESPONSE_CHARS = 12_000;

const CreateAttemptBodyBaseSchema = z.object({
  activity_ref: ActivityRef.optional(),
  question_id: z.string().min(1).optional(),
  mistake_id: z.string().min(1).optional(),
  rating: FsrsRating,
  response_md: z.string().max(MAX_REVIEW_RESPONSE_CHARS).nullable().optional(),
  // YUK-562 (process-data 最小采集) — 学生自述解题思路 / 过程文本，落到 review event
  // payload.reasoning_trace（区别于 response_md 的最终作答）。API 侧先行支持；UI 采集框
  // 过 design pre-flight 后补。OPTIONAL：省略即字段 absent → 既有提交逐字不变。上界共用
  // known.ts 的 REASONING_TRACE_MAX_LEN（单一真相源）。
  reasoning_trace: z.string().max(REASONING_TRACE_MAX_LEN).nullable().optional(),
  // YUK-444 (A10 答题置信度自评) — 学生对本次作答的主观把握（1-5 整数），落到 review
  // event payload.self_confidence。**observe-only**：server 只透传落库，绝不进 θ̂ / FSRS /
  // 判分。OPTIONAL：跳过 / 客观题 auto-commit 省略即字段 absent → 既有提交逐字不变。
  self_confidence: z.number().int().min(1).max(5).nullable().optional(),
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
  session_id: z.string().min(1).nullable().optional(),
  referenced_knowledge_ids: z.array(z.string().min(1)).default([]),
  answer_image_refs: z.array(z.string()).default([]),
  auto_rate: z.boolean().default(false),
  judge_result_v2: JudgeResultV2.optional(),
  judge_provenance_token: z.string().min(1).optional(),
  judge_task_run_id: z.string().min(1).optional(),
  stream_item_id: z.string().min(1).nullable().optional(),
  part_ref: z.string().min(1).nullable().optional(),
});

// The compatibility surface accepts three identity forms, but at least one is required.
// A union keeps that invariant visible as OpenAPI `anyOf` instead of hiding it in a refine.
export const CreateAttemptBodySchema = z.union(
  [
    CreateAttemptBodyBaseSchema.extend({ activity_ref: ActivityRef }),
    CreateAttemptBodyBaseSchema.extend({ question_id: z.string().min(1) }),
    CreateAttemptBodyBaseSchema.extend({ mistake_id: z.string().min(1) }),
  ],
  {
    errorMap: (issue, context) => ({
      message:
        issue.code === z.ZodIssueCode.invalid_union
          ? 'activity_ref, question_id, or mistake_id is required'
          : context.defaultError,
    }),
  },
);

export type CreateAttemptBody = z.infer<typeof CreateAttemptBodySchema>;

export const FsrsStateWireSchema = z
  .object({
    due: z.string().datetime(),
    stability: z.number(),
    difficulty: z.number(),
    elapsed_days: z.number().optional(),
    scheduled_days: z.number(),
    learning_steps: z.number(),
    reps: z.number().int(),
    lapses: z.number().int(),
    state: z.enum(['new', 'learning', 'review', 'relearning']),
    last_review: z.string().datetime().nullable(),
  })
  .passthrough();

export const AttemptCorrectionStepSchema = z.object({
  event_id: z.string(),
  state: z.enum(['active', 'retracted', 'marked_wrong', 'superseded']),
  correction_event_id: z.string().nullable(),
  replacement_event_id: z.string().nullable(),
});

export const AttemptCorrectionStateSchema = z.object({
  original_event_id: z.string(),
  state: z.enum(['active', 'retracted', 'marked_wrong', 'superseded', 'missing', 'cycle']),
  terminal_state: z.enum(['active', 'retracted', 'marked_wrong', 'missing', 'cycle']),
  effective_event_id: z.string().nullable(),
  correction_event_id: z.string().nullable(),
  replacement_event_id: z.string().nullable(),
  chain: z.array(AttemptCorrectionStepSchema),
});

const AttemptJudgeResponseSchema = z
  .object({
    route: z.string(),
    score: z.number().nullable(),
    coarse_outcome: z.enum(['correct', 'partial', 'incorrect', 'unsupported']),
    confidence: z.number().min(0).max(1),
    feedback_md: z.string(),
    evidence_json: z.record(z.unknown()),
    capability_ref: z.object({ id: z.string(), version: z.string() }),
    suggested_rating: FsrsRating.nullable(),
    auto_rated: z.boolean(),
    judge_event_id: z.string().nullable(),
    telemetry: z.unknown().optional(),
  })
  .passthrough();

export const AttemptResponseSchema = z.object({
  next_due_at: z.number().int().nonnegative(),
  new_state: FsrsStateWireSchema,
  review_event: z.object({
    id: z.string(),
    activity_ref: ActivityRef,
    question_id: z.string(),
    rating: FsrsRating,
    fsrs_subject_kind: z.enum(['question', 'knowledge']),
    fsrs_subject_ids: z.array(z.string()),
    response_md: z.string().nullable(),
    latency_ms: z.number().int().nonnegative().nullable(),
    fsrs_state_after: FsrsStateWireSchema,
    due_at_next: z.string().datetime(),
    created_at: z.string().datetime(),
    correction_state: AttemptCorrectionStateSchema,
  }),
  judge: AttemptJudgeResponseSchema.nullable(),
});

export const CreateAppealBodySchema = z.object({
  judge_event_id: z.string().min(1),
  reason_md: z.string().max(2000).optional(),
});

export const AppealResponseSchema = z.object({ appeal_event_id: z.string() });

export const CreateReviewSessionBody = z
  .object({
    paper_id: z.string().min(1).optional(),
  })
  .strict();

export const ReviewSessionStatus = z.enum(['started', 'paused', 'completed', 'abandoned']);

export const UpdateReviewSessionBody = z.object({ status: ReviewSessionStatus });

export const EndReviewSessionBodySchema = z.object({
  status: z.enum(['completed', 'abandoned']).default('completed'),
});

export const LegacyReviewSessionTransitionResponseSchema = z.object({
  ok: z.literal(true),
  status: ReviewSessionStatus,
});

export const ReviewSessionCreatedSchema = z.object({ session_id: z.string() });

export const ReviewSessionSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    status: z.string(),
    paper_id: z.string().nullable(),
  })
  .passthrough();

export const ReviewSessionTransitionSchema = z
  .object({
    id: z.string(),
    type: z.literal('review'),
    previous_status: z.string(),
    status: z.string(),
    changed: z.boolean(),
    allowed_statuses: z.array(z.string()),
  })
  .passthrough();
