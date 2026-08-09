import type { JobWithMetadata } from 'pg-boss';
import sharp from 'sharp';

import { type PreAttachFigure, cropAndUploadFigures } from '@/capabilities/ingestion/server/crop';
import { assignFigures, assignFiguresFromVlm } from '@/capabilities/ingestion/server/figure_attach';
// T-OC slice 2 (YUK-145, OC-1/OC-2): VLM StructureTask owns the structure tree;
// Tencent structure is demoted to a text hint. See
// docs/superpowers/plans/2026-05-30-yuk145-toc-slice2-lane.md.
import { runGlmLayoutParsing } from '@/capabilities/ingestion/server/glm_ocr';
import {
  buildGlmFallbackQuestions,
  deriveGlmLayoutQuality,
  parseGlmLayoutResponse,
  renderGlmHint,
} from '@/capabilities/ingestion/server/glm_ocr_parser';
import { writeIngestionOperationEvent } from '@/capabilities/ingestion/server/operation-store';
import {
  ProviderAttemptLifecycleError,
  ProviderAttemptResumeConflictError,
  TencentSubmitInProgressError,
  createOcrPageProviderContext,
  executeTencentOcrDescribe,
  executeTencentOcrSubmit,
  extractionPageOperationId,
  findSavedTencentJobId,
} from '@/capabilities/ingestion/server/provider-attempts';
import {
  type StructureResult,
  StructureTaskError,
  renderTencentHint,
  runStructureTask,
} from '@/capabilities/ingestion/server/structure';
import {
  type DescribeResponse,
  describeOcrJob,
  pollUntilDone,
  submitOcrJob,
} from '@/capabilities/ingestion/server/tencent_mark';
import { mapTencentError } from '@/capabilities/ingestion/server/tencent_mark_errors';
import {
  type LayoutQuality,
  parseMarkAgentResponse,
} from '@/capabilities/ingestion/server/tencent_mark_parser';
import {
  AUTO_ENROLL_SINGLETON_SECONDS,
  autoEnrollJobEnabled,
} from '@/capabilities/ingestion/server/workflow-judge-config';
import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import type { FigureRefT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { learning_session, source_asset } from '@/db/schema';
import { COPILOT_NUDGE_EVALUATE_QUEUE } from '@/server/boss/queue-names';
import {
  type IngestionExtractionProgressPayloadT,
  writeExtractionProgress,
} from '@/server/events/ingestion-progress';
import type { R2Client } from '@/server/r2';
import { Ingestion } from '@/server/session';
import { and, eq } from 'drizzle-orm';

// ---------- helpers ----------

/**
 * YUK-227 S3 Slice A (F2): Map a normalised bbox centre (cx, cy ∈ [0,1]) to a
 * 3×3 grid label so the VLM can disambiguate multiple figures on the same page.
 * Labels: "top-left" | "top-center" | "top-right" | "mid-left" | "mid-center" |
 * "mid-right" | "bot-left" | "bot-center" | "bot-right".
 * No image bytes are included — this is a text-only spatial anchor.
 */
function bboxCenterPosition(bbox: { x: number; y: number; width: number; height: number }): string {
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const col = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'center' : 'right';
  const row = cy < 1 / 3 ? 'top' : cy < 2 / 3 ? 'mid' : 'bot';
  return `${row}-${col}`;
}

export type TencentOcrJobData = { sessionId: string; operationId?: string };

export type TencentOcrDeps = {
  db: Db;
  r2: R2Client;
  /**
   * YUK-253: default GLM-OCR engine call. Test override lets handler tests stub
   * the GLM HTTP call without hitting the live API. Defaults to the production
   * `runGlmLayoutParsing`.
   */
  glmOcrFn?: typeof runGlmLayoutParsing;
  /**
   * Test override: skip real Tencent SDK calls. PHASE-DEFERRED — kept for the
   * retained `EXTRACT_OCR_ENGINE='tencent'` fallback path (see engine resolution).
   */
  submitFn?: typeof submitOcrJob;
  describeFn?: typeof describeOcrJob;
  tencentPollOptions?: { readonly intervalMs?: number; readonly timeoutMs?: number };
  afterTencentJobSaved?: (jobId: string) => Promise<void>;
  /**
   * YUK-253: explicit engine override for tests (bypasses the EXTRACT_OCR_ENGINE
   * env read). 'glm' (default) | 'tencent' (retained fallback).
   */
  engine?: 'glm' | 'tencent';
  /**
   * Test override for the VLM StructureTask (OC-1/OC-2). Mirrors submitFn/pollFn:
   * lets handler tests stub the VLM without a real multimodal LLM call. Defaults
   * to the production `runStructureTask`.
   */
  runStructureFn?: typeof runStructureTask;
};

export function buildTencentOcrHandler(
  deps: TencentOcrDeps,
): (jobs: JobWithMetadata<TencentOcrJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      try {
        await processOneOcrJob(deps, job);
      } catch (err) {
        if (!shouldKeepExtractionResumable(err, deliveryMetadata(job))) {
          await emitOperationFailureForFailedSession(
            deps.db,
            job.data.sessionId,
            job.data.operationId,
          );
        }
        throw err;
      }
    }
  };
}

function deliveryMetadata(job: JobWithMetadata<TencentOcrJobData>): {
  readonly retryCount: number;
  readonly retryLimit: number;
} {
  const retryCount = 'retryCount' in job ? job.retryCount : 0;
  const retryLimit = 'retryLimit' in job ? job.retryLimit : 0;
  return {
    retryCount: typeof retryCount === 'number' ? retryCount : 0,
    retryLimit: typeof retryLimit === 'number' ? retryLimit : 0,
  };
}

export function normalizeExtractionError(err: unknown): RetryableError | PermanentError {
  if (err instanceof RetryableError || err instanceof PermanentError) return err;
  if (err instanceof ProviderAttemptLifecycleError) {
    switch (err.reason) {
      case 'capacity_exhausted':
      case 'control_plane_unavailable':
      case 'policy_mismatch':
      case 'rate_exhausted':
        return new RetryableError(`Provider attempt admission ${err.reason}`);
      default:
        return mapTencentError(err);
    }
  }
  return mapTencentError(err);
}

function shouldKeepExtractionResumable(
  err: unknown,
  delivery: { readonly retryCount: number; readonly retryLimit: number },
): boolean {
  const normalized = normalizeExtractionError(err);
  if (!(normalized instanceof RetryableError)) return false;
  if (
    normalized instanceof TencentSubmitInProgressError &&
    (normalized.reason === 'active_duplicate' || normalized.reason === 'deadline_mismatch')
  ) {
    return true;
  }
  return delivery.retryCount < delivery.retryLimit;
}

async function emitOperationEventSafely(
  db: Db,
  operationId: string | undefined,
  eventType: 'operation.running' | 'operation.completed' | 'operation.failed',
  payload: Record<string, unknown>,
): Promise<void> {
  if (!operationId) return;
  try {
    await writeIngestionOperationEvent(db, { operationId, eventType, payload });
  } catch (err) {
    console.error('[tencent_ocr_extract] operation event emit failed', {
      operationId,
      eventType,
      err,
    });
  }
}

async function emitOperationFailureSafely(db: Db, operationId: string | undefined): Promise<void> {
  await emitOperationEventSafely(db, operationId, 'operation.failed', {
    error: { code: 'extraction_failed', message: 'Extraction failed', status: 500 },
  });
}

async function emitOperationFailureForFailedSession(
  db: Db,
  sessionId: string,
  operationId: string | undefined,
): Promise<void> {
  if (!operationId) return;
  const rows = await db
    .select({ status: learning_session.status })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  const session = rows[0];
  if (session && session.status !== 'failed') return;
  await emitOperationFailureSafely(db, operationId);
}

/**
 * Emit one extraction-progress event under the deliberate swallow-and-log
 * discipline: a progress emit must NEVER fail an otherwise-succeeding run, so a
 * write error is caught + logged here, never propagated. Centralised so every
 * emit site shares the exact behaviour (and any future emit point inherits it).
 */
async function emitProgressSafely(
  db: Db,
  sessionId: string,
  payload: IngestionExtractionProgressPayloadT,
  logContext: Record<string, unknown> = {},
): Promise<void> {
  try {
    await writeExtractionProgress(db, sessionId, payload);
  } catch (err) {
    console.error('[tencent_ocr_extract] progress emit failed', { sessionId, ...logContext, err });
  }
}

async function processOneOcrJob(
  deps: TencentOcrDeps,
  job: JobWithMetadata<TencentOcrJobData>,
): Promise<void> {
  const { operationId, sessionId } = job.data;
  const bossJobId = job.id;
  const glmOcr = deps.glmOcrFn ?? runGlmLayoutParsing;
  const submit = deps.submitFn ?? submitOcrJob;
  const describe = deps.describeFn ?? describeOcrJob;
  const runStructure = deps.runStructureFn ?? runStructureTask;

  // YUK-253: engine selection. GLM-OCR is the default; 'tencent' is the
  // PERMANENTLY retained switchable engine behind the EXTRACT_OCR_ENGINE flag
  // (owner decision 2026-06-07: dual engines for good — no removal planned;
  // enables same-page A/B comparison + per-scenario switching). A `deps.engine`
  // override lets handler tests pin the path without touching process.env.
  const engine: 'glm' | 'tencent' =
    deps.engine ?? (process.env.EXTRACT_OCR_ENGINE === 'tencent' ? 'tencent' : 'glm');

  // 1. Load session + ALL assets. T-OC slice 2 (OC-2): the VLM sees every page
  //    so it can assemble 跨页大题 — no longer single-page (`[0]`). Read from
  //    learning_session with type='ingestion' filter.
  const sessionRows = await deps.db
    .select()
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')));
  const session = sessionRows[0];
  if (!session) {
    // Don't markExtractionFailed (session doesn't exist); just throw Permanent
    throw new PermanentError(`tencent_ocr_extract: session ${sessionId} not found`);
  }
  const assetIds = session.source_asset_ids;
  if (assetIds.length === 0) {
    await markFailedAndLogCost(
      deps,
      sessionId,
      bossJobId,
      new PermanentError(`session ${sessionId} has no source_asset_ids`),
      engine,
    );
    await emitOperationFailureForFailedSession(deps.db, sessionId, operationId);
    return; // already failed, don't rethrow
  }
  const assetById = new Map<string, typeof source_asset.$inferSelect>();
  for (const id of assetIds) {
    const assetRows = await deps.db.select().from(source_asset).where(eq(source_asset.id, id));
    const asset = assetRows[0];
    if (!asset) {
      await markFailedAndLogCost(
        deps,
        sessionId,
        bossJobId,
        new PermanentError(`source_asset ${id} not found`),
        engine,
      );
      await emitOperationFailureForFailedSession(deps.db, sessionId, operationId);
      return;
    }
    assetById.set(id, asset);
  }

  // 2. markExtractionStarted
  await deps.db.transaction((tx) => Ingestion.markExtractionStarted(tx, sessionId));
  await emitOperationEventSafely(deps.db, operationId, 'operation.running', {
    pg_boss_job_id: bossJobId,
  });

  // YUK-253: GLM bills per synchronous layout_parsing request. Keep counters
  // outside the try so a later page/crop/VLM failure can still log consumed usage.
  let glmPromptTokens = 0;
  let glmCompletionTokens = 0;

  try {
    const sourceDocumentId = session.source_document_id ?? '';
    const warnings: string[] = [];

    // 3-9. Per-page: download → dims → OCR (GLM default / Tencent fallback) →
    //      parse → crop figures. The OCR engine stays the character-level text +
    //      figure-bbox source; its STRUCTURE output is demoted to a hint (OC-1).
    //      Figures are still cropped per page and attached via `assignFigures`
    //      (slice 2b will replace that heuristic with VLM matching — lane §DEFERRED).
    //
    //      YUK-253: both engine branches converge on engine-agnostic accumulators
    //      (`ocrHintMd`, `ocrFallbackQuestions`, `ocrLayout`) so the VLM layer and
    //      fallback below are unchanged.
    const pageImages: Array<{ data: string; mediaType: string }> = [];
    // Tencent path: per-page demoted structure → hint. GLM path: per-page markdown.
    const tencentPages: Array<{
      page_index: number;
      questions: ReturnType<typeof parseMarkAgentResponse>['questions'];
    }> = [];
    const glmPages: ReturnType<typeof parseGlmLayoutResponse>['pages'] = [];
    const glmParseWarnings: string[] = [];
    let allPreFigures: PreAttachFigure[] = [];
    // Worst-of layout_quality across pages, used only by the OCR fallback path
    // (the VLM emits its own layout_quality on the happy path).
    let ocrLayout: LayoutQuality = 'structured';

    for (let pageIndex = 0; pageIndex < assetIds.length; pageIndex++) {
      const assetId = assetIds[pageIndex];
      const asset = assetById.get(assetId);
      if (!asset) {
        throw new PermanentError(`source_asset ${assetId} not found`);
      }

      const imageBytes = await deps.r2.get(asset.storage_key);
      if (!imageBytes) {
        throw new PermanentError(`R2 object missing: ${asset.storage_key}`);
      }
      const pageBuffer = Buffer.from(imageBytes);

      const meta = await sharp(pageBuffer).metadata();
      const pageWidth = meta.width;
      const pageHeight = meta.height;
      if (!pageWidth || !pageHeight) {
        throw new PermanentError('sharp could not determine page image dimensions');
      }

      const pageBase64 = pageBuffer.toString('base64');
      const pageOperationId = extractionPageOperationId({
        canonicalOperationId: operationId,
        bossJobId,
        pageIndex,
      });
      pageImages.push({
        data: pageBase64,
        mediaType: asset.mime_type,
      });

      // figureBoxes from whichever engine ran this page.
      let figureBoxes: import('@/core/schema/structured_question').BBoxT[] = [];

      if (engine === 'glm') {
        // GLM layout_parsing is synchronous (single call, no submit+poll).
        const glmResp = await glmOcr({
          imageBase64: pageBase64,
          mediaType: asset.mime_type,
          providerAttempt: createOcrPageProviderContext(deps.db, pageOperationId),
        });
        glmPromptTokens += glmResp.usage?.prompt_tokens ?? 0;
        glmCompletionTokens += glmResp.usage?.completion_tokens ?? 0;
        // Parse this single page; stamp the handler's pageIndex (the response is
        // one page so layout_details has a single outer entry).
        const parsed = parseGlmLayoutResponse(glmResp, pageIndex);
        glmParseWarnings.push(...parsed.warnings);
        const page = parsed.pages[0];
        if (page) {
          glmPages.push(page);
          figureBoxes = page.figures.map((f) => f.bbox);
        }
      } else {
        // PHASE-DEFERRED (YUK-253): retained Tencent engine behind the flag.
        const savedJobId = await findSavedTencentJobId(deps.db, pageOperationId);
        const tencentJobId =
          savedJobId ??
          (await executeTencentOcrSubmit({
            db: deps.db,
            pageOperationId,
            deliveryStartedOn: job.startedOn,
            params: { ImageBase64: pageBase64 },
            submit,
          }));
        if (savedJobId === null) await deps.afterTencentJobSaved?.(tencentJobId);
        const ocrResp: DescribeResponse = await pollUntilDone(tencentJobId, {
          ...deps.tencentPollOptions,
          describeFn: (jobId) =>
            executeTencentOcrDescribe({
              db: deps.db,
              pageOperationId,
              jobId,
              describe,
            }),
        });
        if (ocrResp.JobStatus === 'FAIL') {
          throw new PermanentError(
            `Tencent OCR job ${tencentJobId} FAIL: ${ocrResp.JobErrorMsg ?? 'unknown'}`,
          );
        }
        const parsed = parseMarkAgentResponse(ocrResp, { pageWidth, pageHeight, pageIndex });
        tencentPages.push({ page_index: pageIndex, questions: parsed.questions });
        warnings.push(...parsed.warnings);
        if (parsed.layout_quality !== 'structured' && ocrLayout === 'structured') {
          ocrLayout = parsed.layout_quality;
        }
        figureBoxes = parsed.figures.map((f) => f.bbox);
      }

      if (figureBoxes.length > 0) {
        const preFigures = await cropAndUploadFigures({
          pageImage: pageBuffer,
          pageAssetId: assetId,
          pageIndex,
          figureBoxes,
          r2: deps.r2,
        });
        allPreFigures = allPreFigures.concat(preFigures);
      }

      // Bug A (fix-docx-ingestion): emit incremental OCR progress per page so the
      // /record SSE UI shows movement instead of a frozen "extracting…". Written on
      // deps.db (NOT inside a tx) so pg_notify fires live; emitProgressSafely owns
      // the swallow-and-log so an emit failure never sinks an otherwise-good run.
      await emitProgressSafely(
        deps.db,
        sessionId,
        { done: pageIndex + 1, total: assetIds.length, stage: 'ocr' },
        { stage: 'ocr', pageIndex },
      );
    }

    if (engine === 'glm') {
      const glmLayout = deriveGlmLayoutQuality(glmPages);
      ocrLayout = glmLayout.layout_quality;
      warnings.push(...glmParseWarnings);
      warnings.push(...glmLayout.warnings);
    }

    // Bug A: all OCR pages done → about to enter the single, slow VLM StructureTask.
    // Emit a final 'structure' progress (bar full, label flips to 结构化中) so the UI
    // doesn't stall silently through the VLM call. Same swallow-and-log discipline.
    await emitProgressSafely(
      deps.db,
      sessionId,
      { done: assetIds.length, total: assetIds.length, stage: 'structure' },
      { stage: 'structure' },
    );

    // 10. VLM StructureTask (OC-2): all page images + the demoted OCR text hint →
    //     normalized cross-page structure tree. On failure (provider down /
    //     unparseable / empty), fall back to the per-page concatenated OCR
    //     structure so extraction never hard-fails on a VLM outage (regression
    //     safety — lane plan §5).
    //
    //     YUK-227 S3 Slice A: pass preFigures so the VLM can self-report
    //     figure↔question assignments (figure_ids on StructureNode → figureAssignments
    //     on StructureResult). The VLM receives only sequence index + page_index;
    //     image bytes are already in pageImages. On VLM failure the fallback path
    //     carries no figureAssignments and assignFiguresFromVlm degrades to the
    //     geometric heuristic (zero regression on the OCR fallback path).
    //
    //     YUK-253: hint + fallback questions are computed per engine, then the VLM
    //     call below is engine-agnostic (runStructure only sees a string hint).
    let ocrHintMd: string;
    let ocrFallbackQuestions: ReturnType<typeof parseMarkAgentResponse>['questions'];
    // YUK-541 (ocr-vlm-fallback-ladder): buildGlmFallbackQuestions() always returns an
    // informative warning ('GLM fallback: page-level standalone, no sub-question split')
    // that was previously discarded here. Capture it now and thread it into the fallback
    // `structure` literal below (only reached if StructureTask actually throws) so the
    // existing `warnings.push(...structure.warnings)` merge point folds it in for free —
    // stays `[]` (no-op) on the VLM-success happy path and on the Tencent engine path.
    let glmFallbackWarnings: string[] = [];
    if (engine === 'glm') {
      ocrHintMd = renderGlmHint(glmPages);
      const fb = buildGlmFallbackQuestions({
        pages: glmPages,
        layout_quality: ocrLayout,
        warnings: [],
      });
      ocrFallbackQuestions = fb.questions;
      glmFallbackWarnings = fb.warnings;
    } else {
      ocrHintMd = renderTencentHint(tencentPages);
      ocrFallbackQuestions = tencentPages.flatMap((p) => p.questions);
    }

    // Build the minimal preFigures descriptor for the VLM prompt.
    //
    // YUK-227 S3 Slice A (F2): include a 3×3 position label derived from the
    // figure's normalised bbox centre so the VLM can distinguish multiple figures
    // on the same page (e.g. "bot-left" vs "top-right"). No image bytes are sent —
    // only the text anchor. The position label matches the figures[] description in
    // the StructureTask system prompt.
    const preFiguresMeta = allPreFigures.map((f, i) => ({
      index: i,
      page_index: f.source_page_index,
      position: bboxCenterPosition(f.source_bbox),
    }));

    let structure: StructureResult;
    let usedVlmPath = true;
    try {
      structure = await runStructure({
        pageImages,
        tencentHintMd: ocrHintMd,
        pageCount: assetIds.length,
        preFigures: preFiguresMeta.length > 0 ? preFiguresMeta : undefined,
        db: deps.db,
        ctx: { r2: deps.r2 },
      });
    } catch (err) {
      if (!(err instanceof StructureTaskError)) throw err;
      if (ocrFallbackQuestions.length === 0) {
        // VLM failed AND the OCR engine produced no structure → genuinely empty.
        throw new PermanentError(
          `StructureTask failed and OCR produced 0 questions: ${err.message}`,
        );
      }
      // YUK-253: name the engine the fallback degraded to. The GLM fallback is
      // page-level standalone (no sub-split); the Tencent fallback is its parsed
      // per-page tree. Both keep the "fell back to <engine>" warning shape.
      const engineLabel = engine === 'glm' ? 'GLM' : 'Tencent';
      warnings.push(
        `StructureTask unavailable (${err.message}); fell back to ${engineLabel} structure`,
      );
      structure = {
        questions: ocrFallbackQuestions,
        layout_quality: ocrLayout,
        // YUK-541: glmFallbackWarnings is [] for the Tencent engine, so this stays a
        // no-op there — folded into `warnings` below via the existing merge point.
        warnings: glmFallbackWarnings,
      };
      usedVlmPath = false;
    }
    warnings.push(...structure.warnings);

    // 11. Assign figures to questions.
    //
    //     YUK-227 S3 Slice A:
    //     - VLM path: assignFiguresFromVlm — VLM assignments take priority;
    //       any figure the VLM did not cover falls back to the geometric heuristic
    //       (no figure is ever dropped — regression safety).
    //     - Tencent fallback path: assignFigures geometric heuristic (unchanged).
    let figureRefs: FigureRefT[];
    if (allPreFigures.length === 0) {
      figureRefs = [];
    } else if (usedVlmPath) {
      figureRefs = assignFiguresFromVlm(
        allPreFigures,
        structure.figureAssignments,
        structure.questions,
      );
    } else {
      figureRefs = assignFigures(allPreFigures, structure.questions);
    }

    // 12. applyExtractionResult —— one question_block per top-level structured
    //     question. A cross-page stem is ONE block spanning its pages.
    //
    //     YUK-227 S3 Slice A: page_spans carry a real page_index on the VLM path
    //     and the GLM fallback path. bbox remains full-page (ADR-0002). Three paths:
    //
    //     VLM path (usedVlmPath=true): q.page_index is now non-null because
    //     nodeToStructured copies node.page_index (P1 fix). Use q.page_index ?? 0
    //     as fallback for any node the VLM omitted page_index on.
    //
    //     GLM fallback path (usedVlmPath=false, engine='glm'): GLM fallback
    //     questions are one standalone question per page and carry real page_index.
    //     Preserve it so multi-page VLM outages still preview on the correct page.
    //
    //     Tencent fallback path (usedVlmPath=false, engine='tencent'):
    //     tencent_mark_parser stamps real page_index on parsed questions
    //     (parser.ts:230,289), but plan §2 step 4 says "腾讯回落路径保持
    //     placeholder". Keeping page_spans at page_index=0 ensures
    //     isAllPlaceholderPageIndex returns true for these sessions, so
    //     block-assembly stays semantic-only. If this is ever relaxed, revise
    //     §2 step 4 first.
    //
    //     YUK-227 S3 Slice A (F3): clamp VLM page_index to [0, pageCount-1].
    //     The VLM may hallucinate out-of-range page indices (e.g. page_index=3 on
    //     a 2-page doc). An out-of-range index is treated as invalid: fall back to
    //     placeholder 0 and log a warning so the anomaly is visible in server logs.
    const pageCount = assetIds.length;
    const blocks = structure.questions.map((q) => {
      const useQuestionPageIndex = usedVlmPath || engine === 'glm';
      const pageIndexSource = usedVlmPath ? 'VLM' : 'GLM fallback';
      let rawPageIndex = useQuestionPageIndex ? (q.page_index ?? 0) : 0;
      if (
        useQuestionPageIndex &&
        (!Number.isInteger(rawPageIndex) || rawPageIndex < 0 || rawPageIndex >= pageCount)
      ) {
        console.warn(
          `[tencent_ocr_extract] ${pageIndexSource} returned out-of-range page_index=${rawPageIndex} ` +
            `(pageCount=${pageCount}) for question id=${q.id ?? '?'}; clamping to 0`,
        );
        rawPageIndex = 0;
      }
      return {
        structured: q,
        figures: figureRefs,
        page_spans: [
          {
            page_index: rawPageIndex,
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            role: 'prompt',
          },
        ],
        source_asset_ids: assetIds,
        image_refs: assetIds,
        // StructureTask emits a calibrated overall confidence. Missing values
        // (fallback engines / old test doubles) fail closed to human review.
        extraction_confidence: structure.extraction_confidence ?? 0,
      };
    });

    if (blocks.length === 0) {
      throw new PermanentError('structure produced 0 questions');
    }

    const extractionResult = await deps.db.transaction((tx) =>
      Ingestion.applyExtractionResult(tx, {
        sessionId,
        sourceDocumentId,
        blocks,
        layoutQuality: structure.layout_quality,
        warnings,
      }),
    );

    // YUK-696: both paid modes are opt-in. Do not even enqueue the worker when
    // both flags are absent/OFF; the extraction remains available for manual review.
    // Inline getStartedBoss() producer (worker process already has boss started
    // → same instance), mirroring attribution_followup → variant_gen. Swallow +
    // log: a failed enqueue must NOT fail an extraction that already succeeded.
    // Failure isolation lives on the dedicated `auto_enroll` queue — an
    // auto-enroll throw never flips this session to 'failed' or re-runs OCR. The
    // applyExtractionResult assertFromState(['extracting']) guard means a
    // succeeded OCR job can never re-reach this line, so the hook fires once.
    if (autoEnrollJobEnabled(process.env)) {
      try {
        const { getStartedBoss } = await import('@/server/boss/client');
        const boss = await getStartedBoss();
        // YUK-486 — dedup the enqueue: singletonKey=sessionId + singletonSeconds collapses two
        // near-simultaneous sends for the same session into one job (dev double-consume:
        // rw:api's embedded RW_WORKER + standalone worker:dev both poll this queue; or an extract
        // retry re-sending). singletonSeconds is REQUIRED — a bare singletonKey is a no-op on a
        // standard-policy queue in pg-boss v12 (see AUTO_ENROLL_SINGLETON_SECONDS). This only
        // REDUCES redundant jobs; the per-block FOR UPDATE claim in runAutoEnrollForSession is the
        // structural guarantee against double-INSERT for any job that still runs.
        await boss.send(
          'auto_enroll',
          { sessionId },
          { singletonKey: sessionId, singletonSeconds: AUTO_ENROLL_SINGLETON_SECONDS },
        );
      } catch (err) {
        console.error('[tencent_ocr_extract] failed to enqueue auto_enroll', err);
      }
    }

    // YUK-577 — fan out to the copilot proactive-nudge evaluator (post-commit, observe-only).
    // Independent try/catch from auto_enroll so a nudge-enqueue failure never masks the auto_enroll
    // hook; a failed enqueue must NOT fail an extraction that already committed.
    try {
      const { getStartedBoss } = await import('@/server/boss/client');
      const boss = await getStartedBoss();
      await boss.send(COPILOT_NUDGE_EVALUATE_QUEUE, {
        kind: 'ingestion_complete',
        session_id: sessionId,
      });
    } catch (err) {
      console.error('[tencent_ocr_extract] failed to enqueue copilot_nudge_evaluate', err);
    }

    await emitOperationEventSafely(deps.db, operationId, 'operation.completed', {
      result: { session_id: sessionId, status: extractionResult.status },
    });
  } catch (err) {
    const mapped = normalizeExtractionError(err);
    await markFailedAndLogCost(
      deps,
      sessionId,
      bossJobId,
      mapped,
      engine,
      {
        promptTokens: glmPromptTokens,
        completionTokens: glmCompletionTokens,
      },
      deliveryMetadata(job),
    );
    if (err instanceof ProviderAttemptResumeConflictError) throw err;
    throw mapped;
  }
}

async function markFailedAndLogCost(
  deps: TencentOcrDeps,
  sessionId: string,
  _bossJobId: string,
  err: unknown,
  _engine: 'glm' | 'tencent' = 'glm',
  _glmUsage: { promptTokens: number; completionTokens: number } = {
    promptTokens: 0,
    completionTokens: 0,
  },
  delivery: { retryCount: number; retryLimit: number } = { retryCount: 0, retryLimit: 0 },
): Promise<void> {
  const mapped = normalizeExtractionError(err);
  if (!shouldKeepExtractionResumable(mapped, delivery)) {
    try {
      await deps.db.transaction((tx) =>
        Ingestion.markExtractionFailed(tx, sessionId, mapped.message),
      );
    } catch (innerErr) {
      // markExtractionFailed itself can throw if state guard rejects (e.g. session already failed
      // from earlier retry). Log and continue —— pg-boss already knows.
      console.error('[tencent_ocr_extract] markExtractionFailed failed', innerErr);
    }
  }
}
