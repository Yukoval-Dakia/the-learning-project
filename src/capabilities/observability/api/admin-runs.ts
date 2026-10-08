import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { loadAdminRuns, parseAdminRunsQuery } from '../public';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const options = parseAdminRunsQuery({
      limit: url.searchParams.get('limit') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      task_kind: url.searchParams.get('task_kind') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
    });
    return Response.json(await loadAdminRuns(db, options));
  } catch (err) {
    return errorResponse(err);
  }
}
