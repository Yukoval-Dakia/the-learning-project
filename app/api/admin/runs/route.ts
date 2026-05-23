import { db } from '@/db/client';
import { type AdminRunStatus, listAdminRuns } from '@/server/admin/ai-observability';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

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
    const rows = await listAdminRuns(db, { limit, status, taskKind });
    return Response.json({ rows, limit: Math.min(Math.max(limit || 50, 1), 200) });
  } catch (err) {
    return errorResponse(err);
  }
}
