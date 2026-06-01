import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { reassignFigure } from '@/server/ingestion/block-structured-edit';

export const runtime = 'nodejs';

const Body = z.object({
  attached_to_index: z.string().min(1),
});

/**
 * PATCH /api/question-blocks/[id]/figures/[asset_id] —— 用户改 figure 归属。
 *
 * 核心逻辑现由 `src/server/ingestion/block-structured-edit.ts#reassignFigure`
 * 单一所有者持有（YUK-195 §4.6），本 route 与 agent 的 `reassign_figure`
 * DomainTool 都调它，不复制逻辑。route 为用户触发，不强制 draft 守卫（保持既有
 * 行为），把判别式结果映射成 HTTP；tool 强制 draft 并映射成 soft skipped。
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; asset_id: string }> },
): Promise<Response> {
  try {
    const { id: blockId, asset_id: assetId } = await params;
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError('validation_error', parsed.error.message, 400);
    }
    const { attached_to_index } = parsed.data;

    const result = await reassignFigure(db, {
      blockId,
      assetId,
      attachedToIndex: attached_to_index,
      // User-initiated PATCH stamps provenance as a manual edit.
      actorRef: 'user',
    });

    switch (result.status) {
      case 'skipped:block_not_found':
        throw new ApiError('not_found', `question_block ${blockId} not found`, 404);
      case 'skipped:figure_not_found':
        throw new ApiError('not_found', `figure ${assetId} not in block ${blockId}`, 404);
      case 'skipped:target_not_found':
        throw new ApiError(
          'validation_error',
          `attached_to_index '${attached_to_index}' not found in question_block.structured tree`,
          400,
        );
      case 'skipped:not_draft':
        // Unreachable here (route does not enforce draft), kept for exhaustiveness.
        throw new ApiError('conflict', `question_block ${blockId} is not draft`, 409);
      case 'written':
        return Response.json({ figures: result.figures });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
