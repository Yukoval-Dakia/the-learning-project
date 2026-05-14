import { z } from 'zod';

import { IngestionEntrypoint } from '@/core/schema/business';
import { db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { initiateUpload } from '@/server/ingestion/session';
import { inArray } from 'drizzle-orm';

export const runtime = 'nodejs';

const Body = z.object({
  entrypoint: IngestionEntrypoint,
  asset_ids: z.array(z.string().min(1)).min(1).max(5),
});

/**
 * POST /api/ingestion —— 创建 ingestion session（status='uploaded'）。
 *
 * Sub 0c 把抽取从这里**剥离**：本 route 只创建会话；客户端拿 session.id 后调
 * POST /api/ingestion/[id]/extract 异步触发抽取，开 SSE 听进度。
 *
 * 旧 sync cascade 行为（Step 0 之前）已删除：
 *   - 不再调 runOCRCascade
 *   - 不再写 question_block 行
 *   - 不再返回 blocks
 *   - error_message 不再写 tier_log JSON（tier 信息现在通过 job_events + SSE 推）
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const body = parsed.data;

    // Validate asset_ids exist
    const foundRows = await db
      .select({ id: source_asset.id })
      .from(source_asset)
      .where(inArray(source_asset.id, body.asset_ids));
    const foundIds = new Set(foundRows.map((r) => r.id));
    const missing = body.asset_ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new ApiError('validation_error', `unknown asset_ids: ${missing.join(', ')}`, 400);
    }

    // IngestionSession.initiateUpload —— single owner for ingestion_session writes
    const { sessionId, sourceDocumentId } = await initiateUpload(db, {
      assetIds: body.asset_ids,
      entrypoint: body.entrypoint,
    });

    return Response.json({
      session: {
        id: sessionId,
        source_document_id: sourceDocumentId,
        status: 'uploaded',
        source_asset_ids: body.asset_ids,
        entrypoint: body.entrypoint,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
