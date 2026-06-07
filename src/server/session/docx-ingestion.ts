import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { learning_session, question_block, source_document } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';

import { writeSessionEvent } from './events';

// YUK-258 — DOCX text-line session lifecycle owner.
//
// The text line does NOT go through pg-boss / VLM extract: pandoc segments the
// docx into structured question_blocks synchronously in the route (sub-second).
// So this owner walks `uploaded → extracted` DIRECTLY — it does NOT reuse
// Ingestion.applyExtractionResult, which hard-asserts assertFromState(['extracting'])
// and would require an upstream queued→extracting transition that has no worker to
// consume it (a永不消费的 pg-boss ghost job).
//
// It DOES reuse the WRITE SHAPE of applyExtractionResult (block insert fields,
// writeJobEvent / writeSessionEvent forms) so the SSE replay + domain-event audit
// stay byte-consistent with the visual line. The single divergence is the state
// machine: no extracting hop.
//
// **layout_quality='structured' (NOT 'text_only')** — pandoc-cut blocks carry
// 题号/选项, they ARE structured. The既有不变式 (applyExtractionResult: structured →
// extracted, text_only/partial → partial) requires structured here to stay
// consistent with status='extracted'. See plan §5 P2.

const SESSION_TABLE = 'ingestion_session' as const;

export interface DocxTextBlockInput {
  structured: StructuredQuestionT;
  /** Embedded-image asset ids attached to this block (in-position归题). */
  imageRefs: string[];
}

export interface InitiateDocxTextUploadParams {
  /** Evidence page-image asset ids (LibreOffice→PDF→PDFium). Pin on the session +
   *  source_document + every block so the review UI can render整页. */
  evidenceAssetIds: string[];
  blocks: DocxTextBlockInput[];
}

export interface InitiateDocxTextUploadResult {
  sessionId: string;
  sourceDocumentId: string;
  blockCount: number;
}

/**
 * Create a text-line ingestion session in ONE transaction and land its blocks
 * directly in `extracted` state. Emits `ingestion.uploaded` then the SSE-terminal
 * `ingestion.extraction_completed`, plus a domain extract event — matching the
 * visual line's audit trail without the queued/extracting hops.
 *
 * Caller MUST pass at least one block (the route rejects 0-block docx with a 400
 * before reaching here, so an empty `blocks` is a programmer error).
 */
export async function initiateDocxTextUpload(
  db: Db,
  params: InitiateDocxTextUploadParams,
): Promise<InitiateDocxTextUploadResult> {
  if (params.blocks.length === 0) {
    throw new Error('initiateDocxTextUpload: blocks must be non-empty');
  }

  return db.transaction(async (tx) => {
    const now = new Date();
    const sourceDocumentId = createId();
    const sessionId = createId();

    // 1. source_document — evidence page images pinned as source_asset_ids.
    await tx.insert(source_document).values({
      id: sourceDocumentId,
      title: null,
      source_asset_ids: params.evidenceAssetIds,
      body_md: null,
      provenance: { entrypoint: 'docx', line: 'text' } as Record<string, unknown>,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // 2. learning_session — uploaded.
    await tx.insert(learning_session).values({
      id: sessionId,
      type: 'ingestion',
      source_document_id: sourceDocumentId,
      source_asset_ids: params.evidenceAssetIds,
      status: 'uploaded',
      entrypoint: 'docx',
      error_message: null,
      warnings: [],
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // 3. ingestion.uploaded — same job_events shape as initiateUpload.
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'ingestion.uploaded',
      payload: { asset_count: params.evidenceAssetIds.length, entrypoint: 'docx' },
    });

    // ---- 直达, 不经 queued/extracting ----

    // 4. N × question_block(status='draft', layout_quality='structured'). Blocks
    //    pin the evidence page images as source_asset_ids; image_refs carry the
    //    in-position embedded-image asset ids. page_spans uses the full-page
    //    degradation (markdown carries no coordinates), mirroring VisionTab's
    //    importMutation ensuredSpans先例.
    const insertedBlockIds: string[] = [];
    for (const blk of params.blocks) {
      const blockId = createId();
      insertedBlockIds.push(blockId);
      await tx.insert(question_block).values({
        id: blockId,
        ingestion_session_id: sessionId,
        source_document_id: sourceDocumentId,
        source_asset_ids: params.evidenceAssetIds,
        page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
        structured: blk.structured,
        figures: [],
        layout_quality: 'structured',
        extracted_prompt_md: null,
        reference_md: null,
        wrong_answer_md: null,
        image_refs: blk.imageRefs,
        crop_refs: [],
        visual_complexity: 'medium',
        extraction_confidence: 1,
        status: 'draft',
        knowledge_hint: null,
        merged_from_block_ids: [],
        imported_question_id: null,
        imported_attempt_event_id: null,
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }

    // 5. learning_session → extracted.
    await tx
      .update(learning_session)
      .set({ status: 'extracted', updated_at: now })
      .where(eq(learning_session.id, sessionId));

    // 6. ingestion.extraction_completed — SSE terminal. UI's SSE_TERMINAL listens
    //    for this to leave the extracting spinner.
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'ingestion.extraction_completed',
      payload: {
        block_count: params.blocks.length,
        layout_quality: 'structured',
        warnings: [],
      },
    });

    // 7. domain extract event — actor_ref='docx_text', outcome='success'
    //    (structured → success, per applyExtractionResult eventOutcome semantics).
    await writeSessionEvent(tx, {
      session_id: sessionId,
      action: 'extract',
      subject_kind: 'source_document',
      subject_id: sourceDocumentId,
      actor_kind: 'agent',
      actor_ref: 'docx_text',
      outcome: 'success',
      payload: {
        structured_block_ids: insertedBlockIds,
        layout_quality: 'structured',
        warnings: [],
      },
      created_at: now,
    });

    return { sessionId, sourceDocumentId, blockCount: params.blocks.length };
  });
}
