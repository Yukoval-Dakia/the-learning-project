import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { learning_session, question_block, source_asset } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { type RunTaskCallCtx, makeRunTaskTextFn } from '@/server/ai/runner-fn';
import type { R2Client } from '@/server/r2';
import { Ingestion } from '@/server/session';
import { assertFromState } from '@/server/session/guards';
import { type VisionBlock, runVisionExtract } from './vision';

export type RescueTier = 2 | 3;
export type RescueStrategy = 'extract' | 'restructure_cloze' | 'restructure_compound';

export type RunRescueParams = {
  db: Db;
  r2: R2Client;
  sessionId: string;
  blockId: string;
  page: number;
  tier: RescueTier;
  strategy?: RescueStrategy;
  /** Inject runTask in tests. Defaults to production runner. */
  runTaskFn?: (kind: string, input: unknown, ctx?: RunTaskCallCtx) => Promise<{ text: string }>;
};

/**
 * 手动 Vision Tier 2/3 救援 —— ADR-0002 修订：用户授权的、付费可见的、可选的救援，
 * **不是自动 fallback**。
 *
 * 当前仅实现 strategy='extract'（重新抽一遍）；'restructure_cloze' / 'restructure_compound'
 * 留为未来扩展（throw not_implemented）。
 *
 * 流程：
 *   1. 验证 session 在 partial/extracted 状态、block 存在
 *   2. 按 session 页序定位请求页，确认属于 block 后下载 asset bytes
 *   3. 调 VisionExtractTask（tier=2 → haiku）或 VisionExtractTaskHeavy（tier=3 → sonnet）
 *   4. 用第一块结果 → 合成 StructuredQuestion（standalone）
 *   5. 调 IngestionSession.applyRescue 写回（事务内 + version bump + writeJobEvent）
 */
export async function runRescue(
  params: RunRescueParams,
): Promise<{ structured: StructuredQuestionT }> {
  if (params.strategy && params.strategy !== 'extract') {
    throw new ApiError(
      'not_implemented',
      `rescue strategy '${params.strategy}' not implemented`,
      501,
    );
  }

  if (!Number.isSafeInteger(params.page) || params.page < 0) {
    throw new ApiError('validation_error', 'rescue page must be a nonnegative integer', 400);
  }

  // Blocks can retain all source pages or only a subset; their first asset is
  // not necessarily the page the learner requested.
  const blocks = await params.db
    .select()
    .from(question_block)
    .where(eq(question_block.id, params.blockId));
  const block = blocks[0];
  if (!block) {
    throw new ApiError('not_found', `question_block ${params.blockId} not found`, 404);
  }
  if (block.ingestion_session_id !== params.sessionId) {
    throw new ApiError(
      'validation_error',
      `block ${params.blockId} does not belong to session ${params.sessionId}`,
      400,
    );
  }
  const [session] = await params.db
    .select({
      status: learning_session.status,
      source_asset_ids: learning_session.source_asset_ids,
    })
    .from(learning_session)
    .where(and(eq(learning_session.id, params.sessionId), eq(learning_session.type, 'ingestion')));
  if (!session) {
    throw new ApiError('not_found', `ingestion session ${params.sessionId} not found`, 404);
  }
  // Check before the optional paid call, including jobs queued while the
  // session was editable. applyRescue checks again inside its write transaction.
  assertFromState(
    session.status,
    ['partial', 'extracted'] as const,
    params.sessionId,
    'Ingestion.applyRescue',
  );

  const assetId = session.source_asset_ids[params.page];
  if (!assetId) {
    throw new ApiError('validation_error', 'rescue page is outside the source document', 400);
  }
  if (!block.source_asset_ids.includes(assetId)) {
    throw new ApiError('validation_error', 'rescue page does not belong to this block', 400);
  }
  const assetRows = await params.db.select().from(source_asset).where(eq(source_asset.id, assetId));
  const asset = assetRows[0];
  if (!asset) {
    throw new ApiError('not_found', `source_asset ${assetId} not found`, 404);
  }

  const imageBytes = await params.r2.get(asset.storage_key);
  if (!imageBytes) {
    throw new ApiError('not_found', `R2 object missing: ${asset.storage_key}`, 404);
  }

  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(params.db);
  const taskKind = params.tier === 2 ? 'VisionExtractTask' : 'VisionExtractTaskHeavy';

  const visionResult = await runVisionExtract({
    assetId,
    mimeType: asset.mime_type,
    imageBytes: imageBytes.buffer as ArrayBuffer,
    pageIndex: params.page,
    runTaskFn: async (kind, input, ctx) => {
      // route through the requested tier
      const result = await runTaskFn(taskKind, input, ctx as RunTaskCallCtx);
      void kind;
      return result;
    },
  });

  const first = visionResult.blocks[0];
  if (!first) {
    throw new ApiError('extraction_failed', 'Vision returned 0 blocks', 422);
  }

  const structured: StructuredQuestionT = visionBlockToStructured(first);
  await params.db.transaction((tx) =>
    Ingestion.applyRescue(tx, {
      sessionId: params.sessionId,
      blockId: params.blockId,
      structured,
      figures: [],
    }),
  );
  return { structured };
}

function visionBlockToStructured(b: VisionBlock): StructuredQuestionT {
  return {
    id: createId(),
    role: 'standalone',
    page_index: b.page_index,
    prompt_text: b.extracted_prompt_md,
    answers: b.reference_md ? [b.reference_md] : undefined,
    source: 'vision_rescue',
    extraction_evidence: b.wrong_answer_md
      ? {
          handwriting: [
            {
              text: b.wrong_answer_md,
              bbox: { x: 0, y: 0, width: 0, height: 0 }, // exact bbox unknown from old Vision format
            },
          ],
        }
      : undefined,
  };
}
