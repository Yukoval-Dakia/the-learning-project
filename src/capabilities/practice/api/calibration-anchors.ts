// YUK-453 cold-start inc-A — POST /api/practice/calibration/anchors: owner
// fixed-anchor write face.
//
// docs/design/2026-06-20-cold-start-day-one-design.md §5 inc-A + §4.1.
//
// owner 钦定 ~5-10 道锚题的难度档（粗分桶，§5 Q2 决策）→ 写 item_calibration
// { b: bucketToLogit(bucket), b_anchor: same, track:'hard', source:'fixed_anchor' }。
// 这是 n=1 唯一不违红线的「校 LLM 难度系统性 offset」杠杆（§4.1 缓解 1）。
//
// 写真身在 src/server/mastery/fixed-anchor.ts（item_calibration 单写者契约——
// db.insert/update(item_calibration) 只允许出现在 src/server/mastery/，
// step9-invariant-audit.test.ts）；本 handler 只 CALL setFixedAnchors，绝不直接写表
// （镜像 review-draft-enable 只 CALL verifyAndPromote 的纪律）。
//
// θ̂ 读路径不动：effectiveB = b_calib ?? b_anchor ?? b 已优先读非 NULL 锚
// （recalibration.ts:90），故新锚自动被选题 / θ̂ 更新读到，无需任何读路径改动（§3 红线 3）。
//
// Auth：/api/* internal-token 中间件由组合根（server/app.ts）统一施加，本 handler 无需再校验。

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { ANCHOR_BUCKETS, type AnchorBucket, setFixedAnchors } from '@/server/mastery/fixed-anchor';

const AnchorEntrySchema = z.object({
  question_id: z.string().min(1, 'question_id is required'),
  // 粗分桶（owner-fixed 五档，非 raw logit）——bucket→logit 由 module const 固定。
  bucket: z.enum(ANCHOR_BUCKETS as [AnchorBucket, ...AnchorBucket[]]),
});

const BodySchema = z
  .array(AnchorEntrySchema)
  .min(1, 'at least one anchor entry is required')
  .max(64, 'too many anchor entries in one request');

export async function POST(req: Request): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }

    const parsed = BodySchema.safeParse(raw);
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
