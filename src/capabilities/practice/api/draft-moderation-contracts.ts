import { z } from 'zod';

export const DraftModerationParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const DraftReviewListQuerySchema = z.object({
  source: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  limit: z.coerce.number().int().default(50),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: z.string().min(1).optional(),
});

const DraftVerifyStatusSchema = z.enum(['unverified', 'needs_review', 'failed']);

const DraftKnowledgeRefSchema = z.object({
  id: z.string(),
  label: z.string(),
});

const DraftReviewRowSchema = z.object({
  id: z.string(),
  prompt_preview: z.string(),
  kind: z.string(),
  source: z.string(),
  created_at: z.string().datetime(),
  difficulty: z.number(),
  knowledge: z.array(DraftKnowledgeRefSchema),
  verify_status: DraftVerifyStatusSchema,
  verify_reason: z.string().nullable(),
});

export const DraftReviewListResponseSchema = z.object({
  rows: z.array(DraftReviewRowSchema),
  limit: z.number().int().min(1).max(200),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  next_cursor: z.string().nullable(),
  data: z.array(DraftReviewRowSchema),
  page: z.object({
    limit: z.number().int().min(1).max(200),
    next_cursor: z.string().nullable(),
  }),
});

export const DraftReviewDetailResponseSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  notation: z.string().nullable(),
  kind: z.string(),
  source: z.string(),
  created_at: z.string().datetime(),
  difficulty: z.number(),
  knowledge: z.array(DraftKnowledgeRefSchema),
  prompt_md: z.string(),
  passage: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  answer: z.string().nullable(),
  verify_status: DraftVerifyStatusSchema,
  verify_reason: z.string().nullable(),
});

export const DraftForceEnableBodySchema = z.object({
  reason: z.string().trim().min(1),
});

export const DraftPromotionResponseSchema = z.object({
  promoted: z.boolean(),
  // verifyAndPromote deliberately forwards open `skipped:*` dispatcher states.
  status: z.string(),
  verify_event_id: z.string().nullable(),
  reason: z.string().nullable(),
});
