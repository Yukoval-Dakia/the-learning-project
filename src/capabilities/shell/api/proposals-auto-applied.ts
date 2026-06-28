// YUK-521 (A4 强度轴)：GET /api/proposals/auto-applied 薄壳——读模型在
// @/server/proposals/auto-applied-read（A 档 auto-applied 卡 + 当前熔断快照）。

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { getAutoAppliedDigest } from '@/server/proposals/auto-applied-read';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await getAutoAppliedDigest(db));
  } catch (err) {
    return errorResponse(err);
  }
}
