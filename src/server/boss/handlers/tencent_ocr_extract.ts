import type { Job } from 'pg-boss';
import sharp from 'sharp';

import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import type { FigureRefT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { learning_session, source_asset } from '@/db/schema';
import { writeCostLedger } from '@/server/ai/log';
import { type PreAttachFigure, cropAndUploadFigures } from '@/server/ingestion/crop';
import { assignFigures, assignFiguresFromVlm } from '@/server/ingestion/figure_attach';
// T-OC slice 2 (YUK-145, OC-1/OC-2): VLM StructureTask owns the structure tree;
// Tencent structure is demoted to a text hint. See
// docs/superpowers/plans/2026-05-30-yuk145-toc-slice2-lane.md.
import {
  type StructureResult,
  StructureTaskError,
  renderTencentHint,
  runStructureTask,
} from '@/server/ingestion/structure';
import {
  type DescribeResponse,
  pollUntilDone,
  submitOcrJob,
} from '@/server/ingestion/tencent_mark';
import { mapTencentError } from '@/server/ingestion/tencent_mark_errors';
import { type LayoutQuality, parseMarkAgentResponse } from '@/server/ingestion/tencent_mark_parser';
import type { R2Client } from '@/server/r2';
import { Ingestion } from '@/server/session';
import { and, eq } from 'drizzle-orm';

export type TencentOcrJobData = { sessionId: string };

const TASK_KIND = 'tencent_ocr_extract';

export type TencentOcrDeps = {
  db: Db;
  r2: R2Client;
  /** Test override: skip real Tencent SDK calls. */
  submitFn?: typeof submitOcrJob;
  pollFn?: typeof pollUntilDone;
  /**
   * Test override for the VLM StructureTask (OC-1/OC-2). Mirrors submitFn/pollFn:
   * lets handler tests stub the VLM without a real multimodal LLM call. Defaults
   * to the production `runStructureTask`.
   */
  runStructureFn?: typeof runStructureTask;
};

export function buildTencentOcrHandler(
  deps: TencentOcrDeps,
): (jobs: Job<TencentOcrJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      await processOneOcrJob(deps, job.data.sessionId, job.id);
    }
  };
}

async function processOneOcrJob(
  deps: TencentOcrDeps,
  sessionId: string,
  bossJobId: string,
): Promise<void> {
  const submit = deps.submitFn ?? submitOcrJob;
  const poll = deps.pollFn ?? pollUntilDone;
  const runStructure = deps.runStructureFn ?? runStructureTask;

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
    );
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
      );
      return;
    }
    assetById.set(id, asset);
  }

  // 2. markExtractionStarted
  await deps.db.transaction((tx) => Ingestion.markExtractionStarted(tx, sessionId));

  try {
    const sourceDocumentId = session.source_document_id ?? '';
    const warnings: string[] = [];

    // 3-9. Per-page: download → dims → Tencent OCR → parse → crop figures.
    //      Tencent stays the character-level text OCR + figure-bbox source; its
    //      STRUCTURE output is demoted to a hint (OC-1). Figures are still
    //      cropped per page and attached via `assignFigures` (slice 2b will
    //      replace that heuristic with VLM matching — see lane plan §DEFERRED).
    const pageImages: Array<{ data: string; mediaType: string }> = [];
    const tencentPages: Array<{
      page_index: number;
      questions: ReturnType<typeof parseMarkAgentResponse>['questions'];
    }> = [];
    let allPreFigures: PreAttachFigure[] = [];
    // Worst-of layout_quality across pages, used only by the Tencent fallback
    // path (the VLM emits its own layout_quality on the happy path).
    let tencentLayout: LayoutQuality = 'structured';

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

      pageImages.push({
        data: pageBuffer.toString('base64'),
        mediaType: asset.mime_type,
      });

      const tencentJobId = await submit({ ImageBase64: pageBuffer.toString('base64') });
      const ocrResp: DescribeResponse = await poll(tencentJobId);
      if (ocrResp.JobStatus === 'FAIL') {
        throw new RetryableError(
          `Tencent OCR job ${tencentJobId} FAIL: ${ocrResp.JobErrorMsg ?? 'unknown'}`,
        );
      }

      const parsed = parseMarkAgentResponse(ocrResp, { pageWidth, pageHeight, pageIndex });
      tencentPages.push({ page_index: pageIndex, questions: parsed.questions });
      warnings.push(...parsed.warnings);
      if (parsed.layout_quality !== 'structured' && tencentLayout === 'structured') {
        tencentLayout = parsed.layout_quality;
      }

      if (parsed.figures.length > 0) {
        const preFigures = await cropAndUploadFigures({
          pageImage: pageBuffer,
          pageAssetId: assetId,
          pageIndex,
          figureBoxes: parsed.figures.map((f) => f.bbox),
          r2: deps.r2,
        });
        allPreFigures = allPreFigures.concat(preFigures);
      }
    }

    // 10. VLM StructureTask (OC-2): all page images + the demoted Tencent text
    //     hint → normalized cross-page structure tree. On failure (provider down
    //     / unparseable / empty), fall back to the per-page concatenated Tencent
    //     structure so extraction never hard-fails on a VLM outage (regression
    //     safety — lane plan §5).
    //
    //     YUK-227 S3 Slice A: pass preFigures so the VLM can self-report
    //     figure↔question assignments (figure_ids on StructureNode → figureAssignments
    //     on StructureResult). The VLM receives only sequence index + page_index;
    //     image bytes are already in pageImages. On VLM failure the fallback path
    //     carries no figureAssignments and assignFiguresFromVlm degrades to the
    //     geometric heuristic (zero regression on the Tencent fallback path).
    const tencentHintMd = renderTencentHint(tencentPages);
    const tencentFallbackQuestions = tencentPages.flatMap((p) => p.questions);

    // Build the minimal preFigures descriptor for the VLM prompt.
    const preFiguresMeta = allPreFigures.map((f, i) => ({
      index: i,
      page_index: f.source_page_index,
    }));

    let structure: StructureResult;
    let usedVlmPath = true;
    try {
      structure = await runStructure({
        pageImages,
        tencentHintMd,
        pageCount: assetIds.length,
        preFigures: preFiguresMeta.length > 0 ? preFiguresMeta : undefined,
        ctx: { db: deps.db, r2: deps.r2 },
      });
    } catch (err) {
      if (!(err instanceof StructureTaskError)) throw err;
      if (tencentFallbackQuestions.length === 0) {
        // VLM failed AND Tencent produced no structure → genuinely empty.
        throw new PermanentError(
          `StructureTask failed and Tencent produced 0 questions: ${err.message}`,
        );
      }
      warnings.push(`StructureTask unavailable (${err.message}); fell back to Tencent structure`);
      structure = {
        questions: tencentFallbackQuestions,
        layout_quality: tencentLayout,
        warnings: [],
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
    const figureRefs: FigureRefT[] =
      allPreFigures.length > 0
        ? usedVlmPath
          ? assignFiguresFromVlm(allPreFigures, structure.figureAssignments, structure.questions)
          : assignFigures(allPreFigures, structure.questions)
        : [];

    // 12. applyExtractionResult —— one question_block per top-level structured
    //     question. A cross-page stem is ONE block spanning its pages.
    //
    //     YUK-227 S3 Slice A: page_spans carry a real page_index on the VLM path
    //     only. bbox remains full-page (ADR-0002). Two paths:
    //
    //     VLM path (usedVlmPath=true): q.page_index is now non-null because
    //     nodeToStructured copies node.page_index (P1 fix). Use q.page_index ?? 0
    //     as fallback for any node the VLM omitted page_index on.
    //
    //     Tencent fallback path (usedVlmPath=false): tencent_mark_parser stamps
    //     real page_index on parsed questions (parser.ts:230,289). We must NOT
    //     use that value here — plan §2 step 4 says "腾讯回落路径保持 placeholder".
    //     Keeping page_spans at page_index=0 ensures isAllPlaceholderPageIndex
    //     returns true for these sessions, so block-assembly stays semantic-only
    //     (correct behaviour — Tencent structure is already per-page, no cross-page
    //     merge signal needed). If this is ever relaxed, revise §2 step 4 first.
    const blocks = structure.questions.map((q) => ({
      structured: q,
      figures: figureRefs,
      page_spans: [
        {
          page_index: usedVlmPath ? (q.page_index ?? 0) : 0,
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          role: 'prompt',
        },
      ],
      source_asset_ids: assetIds,
      image_refs: assetIds,
    }));

    if (blocks.length === 0) {
      throw new PermanentError('structure produced 0 questions');
    }

    await deps.db.transaction((tx) =>
      Ingestion.applyExtractionResult(tx, {
        sessionId,
        sourceDocumentId,
        blocks,
        layoutQuality: structure.layout_quality,
        warnings,
      }),
    );

    // 11. cost_ledger success
    await writeCostLedger(deps.db, {
      task_kind: TASK_KIND,
      provider: 'tencent',
      model: 'QuestionMarkAgent',
      cost: 0,
      tokens_in: 0,
      tokens_out: 0,
      outcome: 'success',
      pgboss_job_id: bossJobId,
    });

    // Strategy D Slice B (YUK-190): fan out to the observe-only auto-enroll job.
    // Inline getStartedBoss() producer (worker process already has boss started
    // → same instance), mirroring attribution_followup → variant_gen. Swallow +
    // log: a failed enqueue must NOT fail an extraction that already succeeded.
    // Failure isolation lives on the dedicated `auto_enroll` queue — an
    // auto-enroll throw never flips this session to 'failed' or re-runs OCR. The
    // applyExtractionResult assertFromState(['extracting']) guard means a
    // succeeded OCR job can never re-reach this line, so the hook fires once.
    try {
      const { getStartedBoss } = await import('@/server/boss/client');
      const boss = await getStartedBoss();
      await boss.send('auto_enroll', { sessionId });
    } catch (err) {
      console.error('[tencent_ocr_extract] failed to enqueue auto_enroll', err);
    }
  } catch (err) {
    await markFailedAndLogCost(deps, sessionId, bossJobId, err);
    throw err; // rethrow so pg-boss retries (Retryable) or archives (Permanent)
  }
}

async function markFailedAndLogCost(
  deps: TencentOcrDeps,
  sessionId: string,
  bossJobId: string,
  err: unknown,
): Promise<void> {
  const mapped =
    err instanceof RetryableError || err instanceof PermanentError ? err : mapTencentError(err);
  const outcome = mapped instanceof RetryableError ? 'failed_retryable' : 'failed_permanent';

  try {
    await deps.db.transaction((tx) =>
      Ingestion.markExtractionFailed(tx, sessionId, mapped.message),
    );
  } catch (innerErr) {
    // markExtractionFailed itself can throw if state guard rejects (e.g. session already failed
    // from earlier retry). Log and continue —— pg-boss already knows.
    console.error('[tencent_ocr_extract] markExtractionFailed failed', innerErr);
  }

  try {
    await writeCostLedger(deps.db, {
      task_kind: TASK_KIND,
      provider: 'tencent',
      model: 'QuestionMarkAgent',
      cost: 0,
      tokens_in: 0,
      tokens_out: 0,
      outcome,
      pgboss_job_id: bossJobId,
    });
  } catch (innerErr) {
    console.error('[tencent_ocr_extract] writeCostLedger failed', innerErr);
  }
}
