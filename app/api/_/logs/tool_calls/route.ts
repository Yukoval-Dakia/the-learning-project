import { db } from '@/db/client';
import { tool_call_log } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { desc, eq } from 'drizzle-orm';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? `${DEFAULT_LIMIT}`, 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
    const taskKind = url.searchParams.get('task_kind');

    const query = db
      .select()
      .from(tool_call_log)
      .orderBy(desc(tool_call_log.occurred_at))
      .limit(limit);

    const items = taskKind ? await query.where(eq(tool_call_log.task_kind, taskKind)) : await query;

    return Response.json({ items, limit });
  } catch (err) {
    return errorResponse(err);
  }
}
