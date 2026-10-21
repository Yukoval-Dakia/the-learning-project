import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { loadCopilotSummary } from '@/server/today/copilot-summary';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadCopilotSummary(db));
  } catch (err) {
    return errorResponse(err);
  }
}
