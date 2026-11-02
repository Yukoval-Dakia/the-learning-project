import { createId } from '@paralleldrive/cuid2';
import type { Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { writeJobEvent } from '@/kernel/job-events';
import { EXTERNAL_REF_OMISSION_NOTICE } from '../docx/omission';
import {
  type IngestionDocumentBirth,
  insertIngestionSourceDocument,
} from './source-document-provenance';

/**
 * Birth of one ingestion session: its source_document, the `uploaded`
 * learning_session row and the `ingestion.uploaded` job event, inside the
 * caller's transaction. Image/PDF/DOCX-visual uploads and the DOCX text line
 * share this; only what happens after `uploaded` differs.
 */
export async function writeIngestionSessionBirth(
  tx: Tx,
  birth: IngestionDocumentBirth & {
    /** job event `asset_count`; the text line counts evidence pages only. */
    uploadedAssetCount: number;
  },
): Promise<{ sessionId: string; sourceDocumentId: string; warnings: string[] }> {
  const sourceDocumentId = createId();
  const sessionId = createId();
  const warnings = birth.externalRefOmission ? [EXTERNAL_REF_OMISSION_NOTICE] : [];
  await insertIngestionSourceDocument(tx, sourceDocumentId, birth);
  await tx.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    source_document_id: sourceDocumentId,
    source_asset_ids: birth.sourceAssetIds,
    status: 'uploaded',
    entrypoint: birth.entrypoint,
    error_message: null,
    warnings,
    started_at: birth.now,
    created_at: birth.now,
    updated_at: birth.now,
    version: 0,
  });
  // business_table stays 'ingestion_session' for SSE replay continuity.
  await writeJobEvent(tx, {
    business_table: 'ingestion_session',
    business_id: sessionId,
    event_type: 'ingestion.uploaded',
    payload: { asset_count: birth.uploadedAssetCount, entrypoint: birth.entrypoint },
  });
  return { sessionId, sourceDocumentId, warnings };
}
