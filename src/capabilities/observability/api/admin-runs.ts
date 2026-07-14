import { db } from '@/db/client';
import { ApiError, collectionPayload, errorResponse } from '@/kernel/http';

import { type AdminRunStatus, listAdminRunsPage } from '../server/ai-observability';

function parseStatus(value: string | null): AdminRunStatus | undefined {
  if (value === null) return undefined;
  if (value === 'running' || value === 'success' || value === 'failure') return value;
  throw new ApiError('validation_error', `invalid run status: ${value}`, 400);
}

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError('validation_error', `invalid limit: ${value}`, 400);
  }
  return Math.min(parsed, 200);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = parseLimit(url.searchParams.get('limit'));
    const status = parseStatus(url.searchParams.get('status'));
    const taskKind = url.searchParams.get('task_kind') ?? undefined;
    const page = await listAdminRunsPage(db, {
      limit,
      status,
      taskKind,
      cursor: url.searchParams.get('cursor') ?? undefined,
    });
    return Response.json(
      collectionPayload(page.rows, { limit: page.limit, next_cursor: page.next_cursor }, page),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
