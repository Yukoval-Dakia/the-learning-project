import { z } from 'zod';

import {
  ActivityRef,
  CauseCategory,
  CoarseOutcome,
  FsrsRating,
  ScoreMeaning,
} from '@/kernel/capability-contract-schemas';
import { ANCHOR_BUCKETS, type AnchorBucket } from '@/server/mastery/fixed-anchor';
import { AttemptCorrectionStateSchema, FsrsStateWireSchema } from './contracts';

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
  activity_ref: ActivityRef.optional(),
  question_id: z.string().min(1).optional(),
  mistake_id: z.string().min(1).optional(),
  response_md: z.string(),
});

const ReviewAdviceJudgeSchema = z.object({
  route: z.string(),
  score: z.number().nullable(),
  score_meaning: ScoreMeaning,
  coarse_outcome: CoarseOutcome,
  confidence: z.number().min(0).max(1),
  feedback_md: z.string(),
  evidence_json: z.record(z.unknown()),
  capability_ref: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  suggested_rating: FsrsRating.nullable(),
  telemetry: z.unknown().optional(),
});

export const ReviewAdviceResponseSchema = z.object({
  activity_ref: ActivityRef,
  question_id: z.string(),
  judge: ReviewAdviceJudgeSchema,
  advice: z.object({
    rating: FsrsRating.nullable(),
    reason: z.string(),
    evidence_score: z.number().nullable(),
  }),
});

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
    }),
  ),
  top_causes: z.array(
    z.object({
      category: CauseCategory,
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

export const FixedAnchorEntrySchema = z.object({
  question_id: z.string().min(1, 'question_id is required'),
  bucket: z.enum(ANCHOR_BUCKETS as [AnchorBucket, ...AnchorBucket[]]),
});

export const FixedAnchorBodySchema = z
  .array(FixedAnchorEntrySchema)
  .min(1, 'at least one anchor entry is required')
  .max(64, 'too many anchor entries in one request');

export const FixedAnchorResponseSchema = z.object({
  anchors: z.array(
    z.object({
      question_id: z.string(),
      bucket: z.enum(ANCHOR_BUCKETS as [AnchorBucket, ...AnchorBucket[]]),
      b: z.number(),
    }),
  ),
});
