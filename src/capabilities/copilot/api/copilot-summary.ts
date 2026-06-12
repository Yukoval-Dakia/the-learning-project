// M5-T3 (YUK-321) — GET /api/today/copilot-summary（等价平移薄 shim）。
// loadCopilotSummary 留在 @/server/today（staying：boss/ai/memory/artifacts/today
// 是新栈活依赖，见 plan 裁决 a）。

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { loadCopilotSummary } from '@/server/today/copilot-summary';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadCopilotSummary(db));
  } catch (err) {
    return errorResponse(err);
  }
}
