import { z } from 'zod';

/** Null means the extraction did not record typed evidence for this condition. */
export const IngestionExtractionNotices = z.object({
  figures_withheld: z.boolean().nullable(),
  content_lost: z.boolean().nullable(),
  figure_handwriting_unverified: z.boolean().nullable(),
});

export type IngestionExtractionNoticesT = z.infer<typeof IngestionExtractionNotices>;
