// POST /api/practice/calibration/anchors: owner fixed-anchor write face.
//
// owner 钦定 ~5-10 道锚题的难度档（粗分桶）→ 写 item_calibration
// { b: bucketToLogit(bucket), b_anchor: same, track:'hard', source:'fixed_anchor' }。
// 这是 n=1 唯一不违红线的「校 LLM 难度系统性 offset」杠杆。
//
// 写真身在 server/mastery/fixed-anchor.ts（item_calibration 单写者契约——直接
// insert/update 只允许出现在 src/server/mastery/）；本 handler 只 CALL
// setFixedAnchors。θ̂ 读路径优先读非 NULL 锚，故新锚自动被选题 / θ̂ 更新读到。
//
// Auth：/api/* internal-token 由组合根（server/app.ts）统一施加。

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { setFixedAnchors } from '@/server/mastery/fixed-anchor';
import { FixedAnchorBodySchema } from './review-planning-contracts';

export async function POST(req: Request): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }

    const parsed = FixedAnchorBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues[0]?.message ?? 'invalid body',
        400,
      );
    }

    const rows = await setFixedAnchors(
      db,
      parsed.data.map((e) => ({ questionId: e.question_id, bucket: e.bucket })),
    );

    return Response.json({
      anchors: rows.map((r) => ({ question_id: r.questionId, bucket: r.bucket, b: r.b })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
