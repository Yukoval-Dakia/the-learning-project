import { z } from 'zod';

import { ImportBody } from './import-schema';

export const MakePaperBody = z.object({
  question_ids: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'must not contain duplicate question_ids',
    })
    .optional(),
});

export const RescueBody = z.object({
  block_id: z.string().min(1),
  page: z.number().int().min(0),
  tier: z.union([z.literal(2), z.literal(3)]),
  strategy: z.enum(['extract', 'restructure_cloze', 'restructure_compound']).optional(),
});

/**
 * Resource-creation contract for ingestion operations. `kind` names the work, not a
 * URL verb; work runs in the OCR queue or the ingestion_operation worker.
 */
export const IngestionOperationRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('extract') }).strict(),
  // Whole-package agent run: one durable job per session.
  z.object({ kind: z.literal('agent') }).strict(),
  z.object({ kind: z.literal('import'), input: ImportBody }).strict(),
  z
    .object({
      kind: z.literal('make_paper'),
      input: MakePaperBody.optional().default({}),
    })
    .strict(),
  z.object({ kind: z.literal('rescue'), input: RescueBody }).strict(),
]);

export type IngestionOperationRequestParsed = z.infer<typeof IngestionOperationRequest>;
export type IngestionOperationKind = IngestionOperationRequestParsed['kind'];
