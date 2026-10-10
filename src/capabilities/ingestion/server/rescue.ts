import { eq } from 'drizzle-orm';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { question_block, source_asset } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { type RunTaskCallCtx, makeRunTaskTextFn } from '@/server/ai/runner-fn';
import type { R2Client } from '@/server/r2';
import { Ingestion } from '@/server/session';
import { runVisionExtract, visionBlockToStructured } from './vision';

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
 *   2. 下载 asset bytes（block.source_asset_ids[page]）
 *   3. 调 VisionExtractTask（tier=2 → haiku）或 VisionExtractTaskHeavy（tier=3 → sonnet）
 *   4. 仅接收唯一题块 → 合成 StructuredQuestion（standalone）
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

  // Locate the requested page in the block source document map.
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
  const assetId =
    Number.isInteger(params.page) && params.page >= 0
      ? block.source_asset_ids[params.page]
      : undefined;
  if (!assetId) {
    throw new ApiError(
      'validation_error',
      `page ${params.page} is not mapped for block ${params.blockId}`,
      400,
    );
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
    imageBytes: Uint8Array.from(imageBytes).buffer,
    pageIndex: params.page,
    runTaskFn: async (kind, input, ctx) => {
      // route through the requested tier
      const result = await runTaskFn(taskKind, input, ctx as RunTaskCallCtx);
      void kind;
      return result;
    },
  });

  if (visionResult.blocks.length > 1) {
    throw new ApiError(
      'ambiguous_rescue',
      'Rescue returned multiple questions; no block was replaced',
      422,
    );
  }
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
