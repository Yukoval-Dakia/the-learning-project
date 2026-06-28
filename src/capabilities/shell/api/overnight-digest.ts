// YUK-520 (A1 夜窗 digest)：GET /api/workbench/overnight-digest 薄壳——聚合逻辑在
// ../server/overnight-digest（昨夜窗 digest 只读读模型）。

import { loadOvernightDigest } from '@/capabilities/shell/server/overnight-digest';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadOvernightDigest(db));
  } catch (err) {
    return errorResponse(err);
  }
}
