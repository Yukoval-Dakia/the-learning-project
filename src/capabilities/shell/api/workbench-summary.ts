// GET /api/workbench/summary route shell; the aggregation lives in
// ../server/workbench-summary.

import { loadWorkbenchSummary } from '@/capabilities/shell/public';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadWorkbenchSummary(db));
  } catch (err) {
    return errorResponse(err);
  }
}
