import type { Db, Tx } from '@/db/client';
import { writeJobEvent } from '@/server/events/writer';
import { z } from 'zod';

export const INGESTION_EXTRACTION_PROGRESS = 'ingestion.extraction_progress' as const;

const SESSION_TABLE = 'ingestion_session' as const;

export const IngestionExtractionProgressPayload = z
  .object({
    done: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    stage: z.enum(['ocr', 'structure']).optional(),
  })
  .refine((value) => value.done <= value.total, {
    message: 'done must not exceed total',
    path: ['done'],
  });
export type IngestionExtractionProgressPayloadT = z.infer<
  typeof IngestionExtractionProgressPayload
>;

export async function writeExtractionProgress(
  tx: Db | Tx,
  sessionId: string,
  payload: IngestionExtractionProgressPayloadT,
): Promise<number> {
  const parsed = IngestionExtractionProgressPayload.parse(payload);
  return writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: sessionId,
    event_type: INGESTION_EXTRACTION_PROGRESS,
    payload: parsed,
  });
}
