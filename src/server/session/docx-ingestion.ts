import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

import {
  AUTO_ENROLL_SINGLETON_SECONDS,
  type IngestionRedactionField,
  autoEnrollJobEnabled,
  writeIngestionUsageReceipt,
} from '@/capabilities/ingestion/public';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import {
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { learning_session, question_block, source_document } from '@/db/schema';
import {
  USAGE_POLICY_PROVENANCE_KEY,
  resolveSessionDerivationPolicy,
} from '@/kernel/read-models/usage-policy';
import { COPILOT_NUDGE_EVALUATE_QUEUE } from '@/server/boss/queue-names';
import { writeJobEvent } from '@/server/events/writer';
import { writeQuestionBlockCreateEvent } from '@/server/projections/question_block-create-event';
import { type DocxExternalRefOmissionFacts, EXTERNAL_REF_OMISSION_NOTICE } from './docx-omission';
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
  /**
   * YUK-1476 — pass ONLY when the converter input was sanitized (external
   * non-hyperlink relationships omitted from the copy pandoc/LibreOffice saw).
   * Lands in source_document.provenance + session warnings as the honest
   * omission audit; no new schema/table, and never the external Target URL.
   */
  externalRefOmission?: DocxExternalRefOmissionFacts;
  /**
   * YUK-1408 — the learner's consented usage for this document. Same contract
   * as Ingestion.initiateUpload: absent = legacy 'allow' default; an explicit
   * value lands on source_document.provenance.usage_policy.
   */
  derivationPolicy?: DerivationPolicyT | null;
  /**
   * YUK-1408 (S1 follow-up) — the privacy-guard facts for the usage receipt.
   * The route runs redactIngestionText over the pandoc markdown (the
   * extraction text this run) and passes the fired categories + per-category
   * span counts; this owner writes the receipt inside the same transaction as
   * the block inserts, mirroring tencent_ocr_extract's apply-time write.
   */
  usageReceipt: {
    redactedFields: IngestionRedactionField[];
    redactionCounts: Partial<Record<IngestionRedactionField, number>>;
  };
}

// Shared with the visual line (Ingestion.initiateUpload) via the zero-dependency
// leaf './docx-omission' — re-exported here so existing type consumers are stable.
export type { DocxExternalRefOmissionFacts } from './docx-omission';

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

  const result = await db.transaction(async (tx) => {
    const now = new Date();
    const sourceDocumentId = createId();
    const sessionId = createId();
    const omission = params.externalRefOmission;
    const warnings = omission ? [EXTERNAL_REF_OMISSION_NOTICE] : [];

    // Codex-1 — the import route validates every block.image_ref against the
    // session's source_asset_ids (import/route.ts §3). Embedded-image asset ids
    // live ONLY on the blocks (imageRefs), so the session/source_document MUST
    // pin them too or any segmented question carrying an embedded image fails
    // import with 'image_ref … not in session source_asset_ids'. Union the
    // evidence page images with every block's embedded refs (deduped, evidence
    // first so page_index 0 still maps to the first evidence asset).
    const embeddedRefs = Array.from(new Set(params.blocks.flatMap((b) => b.imageRefs)));
    const sessionAssetIds = Array.from(new Set([...params.evidenceAssetIds, ...embeddedRefs]));

    // 1. source_document — evidence page images + embedded refs as source_asset_ids.
    //    YUK-1476 — provenance carries the honest omission audit: both digests +
    //    the omitted facts (part/rId/type — never the external Target URL).
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

    // 2. learning_session — uploaded.
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
    for (const [ordinal, blk] of params.blocks.entries()) {
      const blockId = createId();
      insertedBlockIds.push(blockId);
      // Per-block source_asset_ids = evidence page images + THIS block's embedded
      // refs (deduped). The import route copies image_refs straight through, and
      // VisionTab falls back to source_asset_ids when image_refs is empty, so
      // both must carry the embedded ids to pass the membership check.
      const blockAssetIds = Array.from(new Set([...params.evidenceAssetIds, ...blk.imageRefs]));
      const [insertedRow] = await tx
        .insert(question_block)
        .values({
          id: blockId,
          ingestion_session_id: sessionId,
          source_document_id: sourceDocumentId,
          source_asset_ids: blockAssetIds,
          page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
          // YUK-221 — true positional order = the block array index (0-based).
          ordinal,
          structured: blk.structured,
          figures: [],
          layout_quality: 'structured',
          // Codex-2 — VisionTab seeds the editable prompt from extracted_prompt_md
          // (?? ''); a null here opens every DOCX block with an empty prompt that
          // fails import with '题面不能空'. Persist the derived prompt markdown
          // (题号 + 题面 + 选项) from the structured node so the review form lands
          // pre-filled. structured stays the source of truth; this is the rendered view.
          extracted_prompt_md: structuredToPromptMarkdown(blk.structured),
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
        })
        .returning();
      // YUK-471 W3-C1δ — canonical create event (origin='docx'). `extracted_prompt_md` is the legacy
      // column the snapshot EXCLUDES, so the helper drops it before the strict parse barrier.
      await writeQuestionBlockCreateEvent(tx, {
        row: insertedRow,
        origin: 'docx',
        actorKind: 'agent',
        actorRef: 'docx_text',
        now,
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
        warnings,
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
        warnings,
      },
      created_at: now,
    });

    // 8. YUK-1408 — per-extraction usage receipt on the source document, the
    //    text line's equivalent of the OCR job's receipt write (same tx as the
    //    block writes, policy resolved live off the just-inserted session row).
    //    No page image leaves for a model on this line — the rendered evidence
    //    pages are review-UI only — so page_images is honestly 'none';
    //    extracted text reaches models only through the shared
    //    redactIngestionText call-site backstops.
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

  // Codex-3 / YUK-696 — fan out only when a paid mode is explicitly enabled,
  // and only AFTER the transaction
  // commits, mirroring tencent_ocr_extract's post-extract hook so the text DOCX
  // line gets the same AI prefill / auto-enroll observe path as the visual/PDF/
  // image entrypoints. Inline import + swallow-and-log: a failed enqueue must
  // NOT fail an ingestion that already landed its blocks in 'extracted'.
  // Enqueueing after commit guarantees the auto_enroll worker can see the rows.
  if (autoEnrollJobEnabled(process.env)) {
    try {
      const { getStartedBoss } = await import('@/server/boss/client');
      const boss = await getStartedBoss();
      // YUK-486 — same enqueue dedup as the tencent path (parity): singletonKey + singletonSeconds
      // collapses near-simultaneous duplicate sends for one session into a single job. The per-block
      // FOR UPDATE claim in runAutoEnrollForSession is the producer-agnostic structural guarantee
      // against double-INSERT; this key only reduces redundant job runs.
      await boss.send(
        'auto_enroll',
        { sessionId: result.sessionId },
        { singletonKey: result.sessionId, singletonSeconds: AUTO_ENROLL_SINGLETON_SECONDS },
      );
    } catch (err) {
      console.error('[docx_text] failed to enqueue auto_enroll', err);
    }
  }

  // YUK-577 — fan out to the copilot proactive-nudge evaluator (post-commit, observe-only).
  // Independent try/catch from auto_enroll so a nudge-enqueue failure never masks the auto_enroll
  // hook (and vice versa); a failed enqueue must NOT fail an ingestion that already committed.
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
