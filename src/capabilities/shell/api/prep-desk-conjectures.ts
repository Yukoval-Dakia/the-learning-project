// YUK-406 / YUK-440 (教研团 Phase 0 / U4 备课台)：GET /api/prep-desk/conjectures 薄壳——
// 读模型在 ../server/prep-desk（top ≤3 pending conjecture，salience 排序，confidence
// 永不过线）。镜像 /api/workbench/summary 的薄壳形状。

import { loadPrepDeskConjectures } from '@/capabilities/shell/server/prep-desk';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadPrepDeskConjectures(db));
  } catch (err) {
    return errorResponse(err);
  }
}
