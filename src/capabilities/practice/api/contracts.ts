import { z } from 'zod';

export const CreateReviewSessionBody = z
  .object({
    paper_id: z.string().min(1).optional(),
  })
  .strict();

export const ReviewSessionStatus = z.enum(['started', 'paused', 'completed', 'abandoned']);

export const UpdateReviewSessionBody = z.object({ status: ReviewSessionStatus });

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
