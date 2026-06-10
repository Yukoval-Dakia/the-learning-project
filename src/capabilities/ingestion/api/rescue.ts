import { z } from 'zod';

import { runRescue } from '@/capabilities/ingestion/server/rescue';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { getR2 } from '@/server/r2';

const Body = z.object({
  block_id: z.string().min(1),
  page: z.number().int().min(0),
  tier: z.union([z.literal(2), z.literal(3)]),
  strategy: z.enum(['extract', 'restructure_cloze', 'restructure_compound']).optional(),
});

/**
 * POST /api/ingestion/[id]/rescue —— 手动 Vision Tier 2/3 救援。
 *
 * 同步返回 —— Vision 调用本身就快（haiku ~5s, sonnet ~15s），不走 pg-boss。
 * 用户在 review 页选哪个 block 救援 + tier；结果直接替换 block 内容。
 */
export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const sessionId = params.id;
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { block_id, page, tier, strategy } = parsed.data;
    const result = await runRescue({
      db,
      r2: getR2(),
      sessionId,
      blockId: block_id,
      page,
      tier,
      strategy,
    });
    return Response.json({ structured: result.structured });
  } catch (err) {
    return errorResponse(err);
  }
}
