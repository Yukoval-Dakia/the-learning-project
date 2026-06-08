import { z } from 'zod';

import type { Db, Tx } from '@/db/client';
import { writeJobEvent } from './writer';

// Bug A (fix-docx-ingestion) — incremental extraction progress.
//
// The OCR/VLM extraction job previously emitted only TERMINAL job_events
// (ingestion.extracting → ingestion.extraction_completed / _failed), so the
// /record Vision UI sat on "extracting…" with no movement for the whole
// (potentially slow, per-page VLM) run. We now emit one
// `ingestion.extraction_progress` job_event after each page/block is processed.
//
// NOTE on validation scope: job_events are NOT routed through the domain
// `parseEvent` / KnownEvent union (that union governs the `event` table written
// via writeSessionEvent). job_events carry free-form `event_type` + payload by
// design (see src/server/events/writer.ts). To keep this new event type honest
// we define a dedicated Zod payload schema here and parse before emit — the
// schema is the contract the SSE client (VisionTab) reads.

export const INGESTION_EXTRACTION_PROGRESS = 'ingestion.extraction_progress' as const;

// job_events business_table label — kept as 'ingestion_session' for SSE replay
// continuity, matching every other ingestion.* job_event (see
// src/server/session/ingestion.ts SESSION_TABLE).
const SESSION_TABLE = 'ingestion_session' as const;

export const IngestionExtractionProgressPayload = z.object({
  /** 1-based count of pages/blocks processed so far. */
  done: z.number().int().nonnegative(),
  /** Total pages/blocks this run will process. */
  total: z.number().int().positive(),
  /**
   * Coarse phase label so the UI can word the progress line
   * (e.g. "OCR 第 N / M 页"). Optional — absent on legacy/forward paths.
   */
  stage: z.enum(['ocr', 'structure']).optional(),
});
export type IngestionExtractionProgressPayloadT = z.infer<
  typeof IngestionExtractionProgressPayload
>;

/**
 * Emit one `ingestion.extraction_progress` job_event. Parses the payload first
 * so a malformed progress emit fails loudly in tests rather than silently
 * shipping a bad SSE frame. Reuses writeJobEvent (INSERT + pg_notify in the
 * caller's tx) like every other ingestion.* event.
 */
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
