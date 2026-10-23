import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

import {
  AUTO_ENROLL_SINGLETON_SECONDS,
  type IngestionRedactionField,
  autoEnrollJobEnabled,
  writeIngestionUsageReceipt,
} from '@/capabilities/ingestion/public';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { learning_session, source_document } from '@/db/schema';
import {
  USAGE_POLICY_PROVENANCE_KEY,
  resolveSessionDerivationPolicy,
} from '@/kernel/read-models/usage-policy';
import { persistCapturedQuestionBlock } from '@/kernel/records/question-block-creation';
import { COPILOT_NUDGE_EVALUATE_QUEUE } from '@/server/boss/queue-names';
import { writeJobEvent } from '@/server/events/writer';
import { type DocxExternalRefOmissionFacts, EXTERNAL_REF_OMISSION_NOTICE } from './omission';
import { writeSessionEvent } from '../events/session-extract';

// YUK-258 — DOCX text-line session lifecycle owner.
//
// The text line skips pg-boss / VLM: pandoc segments the docx synchronously in
// the route, so this owner walks uploaded → extracted directly. Reusing
// Ingestion.applyExtractionResult would require a queued→extracting hop with no
// worker to consume it (a pg-boss job that never runs).
//
// The write shape (block fields, job_events, domain events) mirrors
// applyExtractionResult so SSE replay and the audit trail stay identical to the
// visual line; only the state machine differs.
//
// layout_quality is 'structured' (not 'text_only') because pandoc blocks carry
// 题号/选项, and the existing invariant maps structured → extracted.

const SESSION_TABLE = 'ingestion_session' as const;

export interface DocxTextBlockInput {
  structured: StructuredQuestionT;
  /** Embedded-image asset ids attached to this block. */
  imageRefs: string[];
}

export interface InitiateDocxTextUploadParams {
  /** Evidence page-image asset ids (LibreOffice→PDF→PDFium), pinned on the
   *  session, source_document, and every block so the UI can render the page. */
  evidenceAssetIds: string[];
  blocks: DocxTextBlockInput[];
  /**
   * YUK-1476 — pass only when the converter input was sanitized (external
   * non-hyperlink relationships omitted). Lands in source_document.provenance and
   * session warnings; never carries the external Target URL.
   */
  externalRefOmission?: DocxExternalRefOmissionFacts;
  /**
   * YUK-1408 — consented usage; absent = legacy 'allow'. An explicit value lands
   * on source_document.provenance.usage_policy.
   */
  derivationPolicy?: DerivationPolicyT | null;
  /**
   * YUK-1408 (S1 follow-up) — privacy-guard facts for the usage receipt. The
   * route redacts the pandoc markdown and passes the fired categories; this owner
   * writes the receipt in the block-insert transaction, mirroring the OCR path.
   */
  usageReceipt: {
    redactedFields: IngestionRedactionField[];
    redactionCounts: Partial<Record<IngestionRedactionField, number>>;
  };
}

// Re-exported so existing consumers of this module keep a stable type import.
export type { DocxExternalRefOmissionFacts } from './omission';

export interface InitiateDocxTextUploadResult {
  sessionId: string;
  sourceDocumentId: string;
  blockCount: number;
}

/**
 * Create a text-line ingestion session and land its blocks directly in
 * `extracted` state, in one transaction. Emits the same audit trail as the
 * visual line (uploaded → extraction_completed + domain extract event) without
 * the queued/extracting hops.
 *
 * Caller must pass at least one block; the route rejects empty docx first, so an
 * empty `blocks` here is a programmer error.
 */
export async function initiateDocxTextUpload(
  db: Db,
  params: InitiateDocxTextUploadParams,
): Promise<InitiateDocxTextUploadResult> {
  if (params.blocks.length === 0) {
    throw new Error('initiateDocxTextUpload: blocks must be non-empty');
  }

  const result = await db.transaction(async (tx) => {
    const now = new Date();
    const sourceDocumentId = createId();
    const sessionId = createId();
    const omission = params.externalRefOmission;
    const warnings = omission ? [EXTERNAL_REF_OMISSION_NOTICE] : [];

    // The import route checks every block.image_ref against the session's
    // source_asset_ids, but embedded-image ids live only on the blocks. Pin them
    // on the session too, or import fails with 'image_ref … not in session
    // source_asset_ids'. Evidence first keeps page_index 0 on the first page.
    const embeddedRefs = Array.from(new Set(params.blocks.flatMap((b) => b.imageRefs)));
    const sessionAssetIds = Array.from(new Set([...params.evidenceAssetIds, ...embeddedRefs]));

    // YUK-1476 — provenance carries the omission audit (both digests and the
    // omitted facts: part/rId/type, never the external Target URL).
    await tx.insert(source_document).values({
      id: sourceDocumentId,
      title: null,
      source_asset_ids: sessionAssetIds,
      body_md: null,
      provenance: {
        entrypoint: 'docx',
        line: 'text',
        // YUK-1408 — explicit consent signal; absence = default 'allow'.
        ...(params.derivationPolicy
          ? {
              [USAGE_POLICY_PROVENANCE_KEY]: {
                derivation_policy: params.derivationPolicy,
              },
            }
          : {}),
        ...(omission
          ? {
              docx_external_ref_omission: {
                input_sha256: omission.inputSha256,
                converter_input_sha256: omission.converterInputSha256,
                omitted: omission.omissions,
                learner_notice: EXTERNAL_REF_OMISSION_NOTICE,
              },
            }
          : {}),
      } as Record<string, unknown>,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    await tx.insert(learning_session).values({
      id: sessionId,
      type: 'ingestion',
      source_document_id: sourceDocumentId,
      source_asset_ids: sessionAssetIds,
      status: 'uploaded',
      entrypoint: 'docx',
      error_message: null,
      warnings,
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // Same job_events shape as initiateUpload, so SSE replay is shared.
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'ingestion.uploaded',
      payload: { asset_count: params.evidenceAssetIds.length, entrypoint: 'docx' },
    });

    // Blocks pin the evidence pages as source_asset_ids; image_refs carry the
    // in-position embedded ids. page_spans degrades to the full page because
    // markdown has no coordinates, mirroring VisionTab's importMutation.
    const insertedBlockIds: string[] = [];
    for (const [ordinal, blk] of params.blocks.entries()) {
      const blockId = createId();
      insertedBlockIds.push(blockId);
      await persistCapturedQuestionBlock(
        tx,
        {
          origin: 'docx',
          blockId,
          sessionId,
          sourceDocumentId,
          ordinal,
          structured: blk.structured,
          evidenceAssetIds: params.evidenceAssetIds,
          imageRefs: blk.imageRefs,
        },
        now,
      );
    }

    await tx
      .update(learning_session)
      .set({ status: 'extracted', updated_at: now })
      .where(eq(learning_session.id, sessionId));

    // SSE terminal: the UI leaves its extracting spinner on this event.
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'ingestion.extraction_completed',
      payload: {
        block_count: params.blocks.length,
        layout_quality: 'structured',
        warnings,
      },
    });

    // Domain extract event; structured maps to success, as in applyExtractionResult.
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
        warnings,
      },
      created_at: now,
    });

    // YUK-1408 — usage receipt, the text line's equivalent of the OCR write.
    // No page image reaches a model here (evidence pages are review-UI only),
    // so page_images is 'none'; text is redacted at the shared call sites.
    await writeIngestionUsageReceipt(tx, {
      sourceDocumentId,
      sessionId,
      derivationPolicy: await resolveSessionDerivationPolicy(tx, sessionId),
      engine: 'docx_text',
      redactedFields: params.usageReceipt.redactedFields,
      redactionCounts: params.usageReceipt.redactionCounts,
      channels: { page_images: 'none', extracted_text: 'redacted' },
      now,
    });

    return { sessionId, sourceDocumentId, blockCount: params.blocks.length };
  });

  // Codex-3 / YUK-696 — mirror tencent_ocr_extract's post-extract hook, only when
  // a paid mode is enabled and only after commit so the worker can see the rows.
  // A failed enqueue must not fail an ingestion that already landed its blocks.
  if (autoEnrollJobEnabled(process.env)) {
    try {
      const { getStartedBoss } = await import('@/server/boss/client');
      const boss = await getStartedBoss();
      // YUK-486 — same dedup as the tencent path: the key only reduces redundant
      // runs; the per-block FOR UPDATE claim is the structural guard against
      // double-INSERT.
      await boss.send(
        'auto_enroll',
        { sessionId: result.sessionId },
        { singletonKey: result.sessionId, singletonSeconds: AUTO_ENROLL_SINGLETON_SECONDS },
      );
    } catch (err) {
      console.error('[docx_text] failed to enqueue auto_enroll', err);
    }
  }

  // YUK-577 — observe-only nudge evaluation. Its own try/catch so neither
  // enqueue can mask the other, and neither fails an ingestion that committed.
  try {
    const { getStartedBoss } = await import('@/server/boss/client');
    const boss = await getStartedBoss();
    await boss.send(COPILOT_NUDGE_EVALUATE_QUEUE, {
      kind: 'ingestion_complete',
      session_id: result.sessionId,
    });
  } catch (err) {
    console.error('[docx_text] failed to enqueue copilot_nudge_evaluate', err);
  }

  return result;
}
