// M4-T5 (YUK-319)：GET /api/workbench/summary 薄壳——聚合逻辑在
// ../server/workbench-summary（today 重生读模型）。

import { loadWorkbenchSummary } from '@/capabilities/shell/server/workbench-summary';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadWorkbenchSummary(db));
  } catch (err) {
    return errorResponse(err);
  }
}
