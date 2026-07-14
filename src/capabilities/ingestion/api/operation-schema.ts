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
 * POST /api/ingestion-sessions/[id]/operations 的资源创建契约。
 *
 * `kind` 是 operation 的类型，不是要直接执行的 URL 动词；所有可能耗时的工作
 * 都先创建可轮询资源，再由既有 OCR 队列或 ingestion_operation worker 执行。
 */
export const IngestionOperationRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('extract') }).strict(),
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
