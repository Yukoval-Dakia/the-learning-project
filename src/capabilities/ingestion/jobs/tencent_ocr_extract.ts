import { and, eq } from 'drizzle-orm';
import type { JobWithMetadata } from 'pg-boss';
import sharp from 'sharp';
import { type PreAttachFigure, cropAndUploadFigures } from '@/capabilities/ingestion/server/crop';
import {
  type IngestionExtractionProgressPayloadT,
  writeExtractionProgress,
} from '@/capabilities/ingestion/server/events/extraction-progress';
import {
  assignFigures,
  assignFiguresFromVlm,
  figuresForQuestion,
} from '@/capabilities/ingestion/server/figure_attach';
// The VLM StructureTask owns the structure tree; OCR output is only a text hint.
import { runGlmLayoutParsing } from '@/capabilities/ingestion/server/glm_ocr';
import {
  buildGlmFallbackQuestions,
  deriveGlmLayoutQuality,
  parseGlmLayoutResponse,
  renderGlmHint,
} from '@/capabilities/ingestion/server/glm_ocr_parser';
import { writeIngestionOperationEvent } from '@/capabilities/ingestion/server/operation-store';
import {
  redactIngestionText,
  writeIngestionUsageReceipt,
} from '@/capabilities/ingestion/server/privacy-guard';
import {
  ProviderAttemptLifecycleError,
  ProviderAttemptResumeConflictError,
  TencentSubmitInProgressError,
  createOcrPageProviderContext,
  executeTencentOcrDescribe,
  executeTencentOcrSubmit,
  extractionPageOperationId,
} from '@/capabilities/ingestion/server/provider-attempts';
import * as Ingestion from '@/capabilities/ingestion/server/session-lifecycle';
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
import { getConfig } from '@/core/config/store';
import type { FigureRefT } from '@/core/schema/structured_question';
import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { learning_session, source_asset } from '@/db/schema';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { COPILOT_NUDGE_EVALUATE_QUEUE } from '@/server/boss/queue-names';
import type { R2Client } from '@/server/r2';

// ---------- helpers ----------

/**
 * Maps a normalized bbox centre to a 3×3 grid label so the VLM can tell apart
 * figures on one page. Text only; no image bytes.
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
  /** GLM-OCR engine call. Defaults to runGlmLayoutParsing. */
  glmOcrFn?: typeof runGlmLayoutParsing;
  /** Tencent SDK seams, retained for the `EXTRACT_OCR_ENGINE='tencent'` path. */
  submitFn?: typeof submitOcrJob;
  describeFn?: typeof describeOcrJob;
  tencentPollOptions?: { readonly intervalMs?: number; readonly timeoutMs?: number };
  afterTencentJobSaved?: (jobId: string) => Promise<void>;
  /** Explicit engine override for tests; defaults to the env setting. */
  engine?: 'glm' | 'tencent';
  /** VLM StructureTask seam. Defaults to runStructureTask. */
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
    normalized.reason === 'active_duplicate'
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

/** Progress emission is best-effort: a write failure is logged, never thrown. */
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

  // GLM is the default; Tencent remains a permanently supported engine selected by
  // EXTRACT_OCR_ENGINE. deps.engine pins it for tests.
  const engine: 'glm' | 'tencent' =
    deps.engine ?? (getConfig('EXTRACT_OCR_ENGINE') === 'tencent' ? 'tencent' : 'glm');

  // 1. Load the session and all assets; the VLM sees every page so it can assemble
  //    cross-page questions.
  const sessionRows = await deps.db
    .select()
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')));
  const session = sessionRows[0];
  if (!session) {
    // No session to mark failed; throw permanent.
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

  // Keep paid-usage counters outside the try so a later failure can still log spend.
  let glmPromptTokens = 0;
  let glmCompletionTokens = 0;

  try {
    const sourceDocumentId = session.source_document_id ?? '';
    const warnings: string[] = [];

    // 3-9. Per page: download, measure, OCR, parse, crop figures. OCR supplies text
    //      and figure boxes; its structure is only a hint. Both engines feed the
    //      same accumulators so the VLM layer below stays engine-agnostic.
    const pageImages: Array<{ data: string; mediaType: string }> = [];
    // Tencent path: per-page demoted structure → hint. GLM path: per-page markdown.
    const tencentPages: Array<{
      page_index: number;
      questions: ReturnType<typeof parseMarkAgentResponse>['questions'];
    }> = [];
    const glmPages: ReturnType<typeof parseGlmLayoutResponse>['pages'] = [];
    const glmParseWarnings: string[] = [];
    let allPreFigures: PreAttachFigure[] = [];
    // Worst layout across pages, used only by the OCR fallback.
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
        // One page per response, so stamp the handler's pageIndex.
        const parsed = parseGlmLayoutResponse(glmResp, pageIndex);
        glmParseWarnings.push(...parsed.warnings);
        const page = parsed.pages[0];
        if (page) {
          glmPages.push(page);
          figureBoxes = page.figures.map((f) => f.bbox);
        }
      } else {
        // Retained Tencent engine behind the flag.
        const tencentJobId = await executeTencentOcrSubmit({
          db: deps.db,
          pageOperationId,
          bossJobId,
          deliveryRetryCount: deliveryMetadata(job).retryCount,
          deliveryStartedOn: job.startedOn,
          params: { ImageBase64: pageBase64 },
          submit,
          afterJobSaved: deps.afterTencentJobSaved,
        });
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
          db: deps.db,
        });
        allPreFigures = allPreFigures.concat(preFigures);
      }

      // Emit per-page progress on deps.db, outside any tx, so pg_notify fires live.
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

    // Mark the transition into the slow VLM call so the UI does not stall silently.
    await emitProgressSafely(
      deps.db,
      sessionId,
      { done: assetIds.length, total: assetIds.length, stage: 'structure' },
      { stage: 'structure' },
    );

    // 10. VLM StructureTask: all page images plus the OCR hint produce the cross-page
    //     tree. If the VLM fails, fall back to the engine's OCR structure so an outage
    //     never hard-fails extraction. On the fallback, only OCR containment binds
    //     figures because there are no VLM assignments.
    let ocrHintMd: string;
    let ocrFallbackQuestions: ReturnType<typeof parseMarkAgentResponse>['questions'];
    // Carries the GLM fallback warning into the fallback structure; empty on the
    // Tencent path and unused when the VLM succeeds.
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

    // Position label plus exact bbox helps distinguish crops in the same grid cell.
    const preFiguresMeta = allPreFigures.map((f, i) => ({
      index: i,
      page_index: f.source_page_index,
      position: bboxCenterPosition(f.source_bbox),
      bbox: f.source_bbox,
    }));

    // Redact here so the usage receipt records which categories fired; the task
    // also redacts internally as a backstop for its other callers.
    const hintRedaction = redactIngestionText(ocrHintMd);

    let structure: StructureResult;
    let usedVlmPath = true;
    try {
      structure = await runStructure({
        pageImages,
        tencentHintMd: hintRedaction.text,
        pageCount: assetIds.length,
        preFigures: preFiguresMeta.length > 0 ? preFiguresMeta : undefined,
        db: deps.db,
        ctx: { r2: deps.r2 },
      });
    } catch (err) {
      if (!(err instanceof StructureTaskError)) throw err;
      if (ocrFallbackQuestions.length === 0) {
        // VLM failed and OCR produced nothing, so extraction is genuinely empty.
        throw new PermanentError(
          `StructureTask failed and OCR produced 0 questions: ${err.message}`,
        );
      }
      // Name the engine the fallback degraded to.
      const engineLabel = engine === 'glm' ? 'GLM' : 'Tencent';
      warnings.push(
        `StructureTask unavailable (${err.message}); fell back to ${engineLabel} structure`,
      );
      structure = {
        questions: ocrFallbackQuestions,
        layout_quality: ocrLayout,
        warnings: glmFallbackWarnings,
      };
      usedVlmPath = false;
    }
    warnings.push(...structure.warnings);

    // 11. Bind only evidenced ownership; ambiguous crops stay source assets.
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
    const boundFigureIds = new Set(figureRefs.map((figure) => figure.asset_id));
    for (const figure of allPreFigures) {
      if (!boundFigureIds.has(figure.asset_id)) {
        warnings.push(`Figure ${figure.asset_id} retained in source; assignment withheld`);
      }
    }

    // 12. One question_block per top-level question; a cross-page stem is one block.
    //     VLM and GLM fallback carry real page indices, while the Tencent fallback
    //     deliberately keeps page_index=0 so block assembly stays semantic-only.
    //     Out-of-range page indices are hallucinated: clamp to 0 and warn.
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
        figures: figuresForQuestion(q, figureRefs),
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

    const extractionResult = await deps.db.transaction(async (tx) => {
      const result = await Ingestion.applyExtractionResult(tx, {
        sessionId,
        sourceDocumentId,
        blocks,
        layoutQuality: structure.layout_quality,
        warnings,
      });
      // Usage receipt records the policy, consented usage, channels, and fired
      // redaction categories, never values. Atomic with the block writes.
      if (sourceDocumentId) {
        await writeIngestionUsageReceipt(tx, {
          sourceDocumentId,
          sessionId,
          derivationPolicy: await resolveSessionDerivationPolicy(tx, sessionId),
          engine,
          redactedFields: hintRedaction.fields,
          redactionCounts: hintRedaction.counts,
        });
      }
      return result;
    });

    // Paid modes are opt-in. Enqueue failures are logged, never fatal to a
    // committed extraction; the dedicated auto_enroll queue isolates its failures,
    // and the extraction state guard means this hook fires once.
    if (autoEnrollJobEnabled(process.env)) {
      try {
        const { getStartedBoss } = await import('@/server/boss/client');
        const boss = await getStartedBoss();
        // singletonSeconds is required: a bare singletonKey is a no-op on a
        // standard-policy queue. This only reduces duplicates; the per-block FOR
        // UPDATE claim is the structural guard.
        await boss.send(
          'auto_enroll',
          { sessionId },
          { singletonKey: sessionId, singletonSeconds: AUTO_ENROLL_SINGLETON_SECONDS },
        );
      } catch (err) {
        console.error('[tencent_ocr_extract] failed to enqueue auto_enroll', err);
      }
    }

    // Post-commit, observe-only nudge evaluation. Isolated from auto_enroll so
    // neither enqueue failure masks the other or fails the extraction.
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
      // The state guard may reject an already-failed session; pg-boss already knows.
      console.error('[tencent_ocr_extract] markExtractionFailed failed', innerErr);
    }
  }
}
