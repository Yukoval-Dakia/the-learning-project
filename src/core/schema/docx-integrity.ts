import { z } from 'zod';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DocxIssue = z.enum(['image_association', 'prompt_missing', 'missing_media']);
const AssetEvidence = z.object({ asset_id: z.string().min(1), sha256: Digest });
const Region = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1, 'region exceeds page');

/** A source-bound human assertion, not automatic proof of visual ownership. */
export const DocxConfirmation = z.object({
  block_id: z.string().min(1),
  block_version: z.number().int().nonnegative(),
  issue: z.enum(['image_association', 'prompt_missing']),
  source_sha256: Digest,
  content_sha256: Digest,
  page: AssetEvidence.extend({ region: Region }),
  media: z.array(AssetEvidence).max(100),
});

export const DocxIntegrity = z.object({
  schema_version: z.literal(1),
  input_sha256: Digest.nullable(),
  converter_input_sha256: Digest.nullable(),
  markdown_sha256: Digest,
  page_asset_ids: z.array(z.string()),
  media_asset_ids: z.array(z.string()),
  assets: z.array(AssetEvidence),
  blocks: z.array(
    z.object({
      block_id: z.string(),
      candidate_media_ids: z.array(z.string()),
      missing_media_paths: z.array(z.string()),
      issues: z.array(DocxIssue),
    }),
  ),
  confirmations: z.array(
    DocxConfirmation.extend({
      actor_ref: z.literal('block_import'),
      confirmed_at: z.string(),
    }),
  ),
});

export type DocxIntegrityT = z.infer<typeof DocxIntegrity>;
