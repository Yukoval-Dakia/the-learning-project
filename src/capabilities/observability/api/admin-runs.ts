import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

import { type AdminRunStatus, listAdminRunsPage } from '../server/ai-observability';

function parseStatus(value: string | null): AdminRunStatus | undefined {
  if (value === 'running' || value === 'success' || value === 'failure') return value;
  return undefined;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    const status = parseStatus(url.searchParams.get('status'));
    const taskKind = url.searchParams.get('task_kind') ?? undefined;
    const page = await listAdminRunsPage(db, { limit, status, taskKind });
    return Response.json(page);
  } catch (err) {
    return errorResponse(err);
  }
}
