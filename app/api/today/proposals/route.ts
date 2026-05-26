import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { loadTodayProposalKpi } from '@/server/today/proposal-kpi';

export const runtime = 'nodejs';

export async function GET(_req: Request): Promise<Response> {
  try {
    return Response.json(await loadTodayProposalKpi(db));
  } catch (err) {
    return errorResponse(err);
  }
}
