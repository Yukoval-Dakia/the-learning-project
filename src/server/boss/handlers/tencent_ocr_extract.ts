import type { Job } from 'pg-boss';
import sharp from 'sharp';

import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { learning_session, source_asset } from '@/db/schema';
import { writeCostLedger } from '@/server/ai/log';
import { type PreAttachFigure, cropAndUploadFigures } from '@/server/ingestion/crop';
import { assignFigures } from '@/server/ingestion/figure_attach';
import { Ingestion } from '@/server/session';
import {
  type DescribeResponse,
  pollUntilDone,
  submitOcrJob,
} from '@/server/ingestion/tencent_mark';
import { mapTencentError } from '@/server/ingestion/tencent_mark_errors';
import { parseMarkAgentResponse } from '@/server/ingestion/tencent_mark_parser';
import type { R2Client } from '@/server/r2';
import { and, eq } from 'drizzle-orm';

export type TencentOcrJobData = { sessionId: string };

const TASK_KIND = 'tencent_ocr_extract';

export type TencentOcrDeps = {
  db: Db;
  r2: R2Client;
  /** Test override: skip real Tencent SDK calls. */
  submitFn?: typeof submitOcrJob;
  pollFn?: typeof pollUntilDone;
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

  // 1. Load session + asset (first asset; v0 单页 only). Post-Step 5: read from
  //    learning_session with type='ingestion' filter — old `ingestion_session`
  //    rows are migrated; new writes go to learning_session.
  const sessionRows = await deps.db
    .select()
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')));
  const session = sessionRows[0];
  if (!session) {
    // Don't markExtractionFailed (session doesn't exist); just throw Permanent
    throw new PermanentError(`tencent_ocr_extract: session ${sessionId} not found`);
  }
  const assetId = session.source_asset_ids[0];
  if (!assetId) {
    await markFailedAndLogCost(
      deps,
      sessionId,
      bossJobId,
      new PermanentError(`session ${sessionId} has no source_asset_ids`),
    );
    return; // already failed, don't rethrow
  }
  const assetRows = await deps.db.select().from(source_asset).where(eq(source_asset.id, assetId));
  const asset = assetRows[0];
  if (!asset) {
    await markFailedAndLogCost(
      deps,
      sessionId,
      bossJobId,
      new PermanentError(`source_asset ${assetId} not found`),
    );
    return;
  }

  // 2. markExtractionStarted
  await deps.db.transaction((tx) => Ingestion.markExtractionStarted(tx, sessionId));

  try {
    // 3. Download asset
    const imageBytes = await deps.r2.get(asset.storage_key);
    if (!imageBytes) {
      throw new PermanentError(`R2 object missing: ${asset.storage_key}`);
    }
    const pageBuffer = Buffer.from(imageBytes);

    // 4. Read page dimensions
    const meta = await sharp(pageBuffer).metadata();
    const pageWidth = meta.width;
    const pageHeight = meta.height;
    if (!pageWidth || !pageHeight) {
      throw new PermanentError('sharp could not determine page image dimensions');
    }

    // 5. Submit OCR job
    const base64 = pageBuffer.toString('base64');
    const tencentJobId = await submit({ ImageBase64: base64 });

    // 6. Poll
    const ocrResp: DescribeResponse = await poll(tencentJobId);
    if (ocrResp.JobStatus === 'FAIL') {
      throw new RetryableError(
        `Tencent OCR job ${tencentJobId} FAIL: ${ocrResp.JobErrorMsg ?? 'unknown'}`,
      );
    }

    // 7. Parse
    const parsed = parseMarkAgentResponse(ocrResp, {
      pageWidth,
      pageHeight,
      pageIndex: 0,
    });

    // 8. Crop figures
    let preFigures: PreAttachFigure[] = [];
    if (parsed.figures.length > 0) {
      preFigures = await cropAndUploadFigures({
        pageImage: pageBuffer,
        pageAssetId: assetId,
        pageIndex: 0,
        figureBoxes: parsed.figures.map((f) => f.bbox),
        r2: deps.r2,
      });
    }

    // 9. Assign figures heuristically
    const figureRefs = assignFigures(preFigures, parsed.questions);

    // 10. applyExtractionResult —— 单 block / 单 stem 假设：把所有 questions
    //     合并入一个 question_block。多 top-level question 视为同 page 的多块。
    const sourceDocumentId = session.source_document_id ?? '';
    const blocks = parsed.questions.map((q) => ({
      structured: q,
      // figures.attached_to_index 指向某 question id；过滤匹配此 block 顶层 id
      // 或其 sub 的 figures（简化：每 block 拿全部 figures，UI 内部 attached_to_index 区分）
      figures: figureRefs,
      page_spans: [
        {
          page_index: 0,
          bbox: q.bbox ?? { x: 0, y: 0, width: 1, height: 1 },
          role: 'prompt',
        },
      ],
      source_asset_ids: [assetId],
      image_refs: [assetId],
    }));

    if (blocks.length === 0) {
      // parser returned 0 questions → failed
      throw new PermanentError('parser returned 0 questions');
    }

    await deps.db.transaction((tx) =>
      Ingestion.applyExtractionResult(tx, {
        sessionId,
        sourceDocumentId,
        blocks,
        layoutQuality: parsed.layout_quality,
        warnings: parsed.warnings,
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
    await deps.db.transaction((tx) => Ingestion.markExtractionFailed(tx, sessionId, mapped.message));
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
