import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { question_block, source_asset } from '@/db/schema';
import type { R2Client } from '@/server/r2';
import { ApiError } from '@/server/http/errors';

import { applyRescue } from './session';
import { runVisionExtract, type VisionBlock } from './vision';

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
  runTaskFn?: (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
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
 *   2. 下载 asset bytes（block.source_asset_ids[0] 假设单 asset）
 *   3. 调 VisionExtractTask（tier=2 → haiku）或 VisionExtractTaskHeavy（tier=3 → sonnet）
 *   4. 用第一块结果 → 合成 StructuredQuestion（standalone）
 *   5. 调 IngestionSession.applyRescue 写回（事务内 + version bump + writeJobEvent）
 */
export async function runRescue(params: RunRescueParams): Promise<{ structured: StructuredQuestionT }> {
  if (params.strategy && params.strategy !== 'extract') {
    throw new ApiError(
      'not_implemented',
      `rescue strategy '${params.strategy}' not implemented`,
      501,
    );
  }

  // Locate block + its first asset
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
  const assetId = block.source_asset_ids[0];
  if (!assetId) {
    throw new ApiError('validation_error', `block ${params.blockId} has no source_asset_ids`, 400);
  }
  const assetRows = await params.db
    .select()
    .from(source_asset)
    .where(eq(source_asset.id, assetId));
  const asset = assetRows[0];
  if (!asset) {
    throw new ApiError('not_found', `source_asset ${assetId} not found`, 404);
  }

  const imageBytes = await params.r2.get(asset.storage_key);
  if (!imageBytes) {
    throw new ApiError('not_found', `R2 object missing: ${asset.storage_key}`, 404);
  }

  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;
  const taskKind = params.tier === 2 ? 'VisionExtractTask' : 'VisionExtractTaskHeavy';

  const visionResult = await runVisionExtract({
    assetId,
    mimeType: asset.mime_type,
    imageBytes: imageBytes.buffer as ArrayBuffer,
    pageIndex: params.page,
    runTaskFn: async (kind, input, ctx) => {
      // route through the requested tier
      const result = await runTaskFn(taskKind, input, ctx);
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
    applyRescue(tx, {
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

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}
