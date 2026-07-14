import { z } from 'zod';

import { MAX_PDF_PAGES } from '@/core/limits';
import { IngestionEntrypoint } from '@/core/schema/business';

export const CreateIngestionSessionBody = z.object({
  entrypoint: IngestionEntrypoint,
  asset_ids: z.array(z.string().min(1)).min(1).max(MAX_PDF_PAGES),
});

export const IngestionSessionSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    entrypoint: z.string().nullable(),
    source_document_id: z.string().nullable().optional(),
    source_asset_ids: z.array(z.string()),
  })
  .passthrough();

export const IngestionSessionResponseSchema = z.object({
  session: IngestionSessionSchema,
});

export const IngestionOperationSchema = z
  .object({
    id: z.string(),
    session_id: z.string(),
    status: z.string(),
  })
  .passthrough();
