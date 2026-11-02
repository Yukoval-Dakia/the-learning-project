import { z } from 'zod';
import { ANCHOR_BUCKETS, type AnchorBucket } from '../server/fixed-anchor';

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
