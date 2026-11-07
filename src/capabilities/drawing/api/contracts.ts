import { z } from 'zod';

/** Learner scope is proven by naming the owning session — token-only reads never cross learners. */
export const DrawingSessionQuerySchema = z
  .object({
    session_id: z.string().min(1).max(128),
  })
  .strict();

export const DrawingStatusResponseSchema = z
  .object({
    drawing_id: z.string(),
    status: z.enum([
      'queued',
      'running',
      'ready',
      'waiting_quota',
      'waiting_login',
      'failed',
      'cancelled',
      'expired',
    ]),
    alt: z.string(),
    caption: z.string().nullable(),
    asset: z
      .object({
        asset_id: z.string(),
        digest: z.string(),
        mime_type: z.literal('image/svg+xml'),
      })
      .strict()
      .nullable(),
    error: z.object({ kind: z.string(), detail: z.string() }).strict().nullable(),
    retry_at: z.string().nullable(),
    attempt: z.number().int(),
    version: z.number().int(),
    expires_at: z.string(),
  })
  .strict();
