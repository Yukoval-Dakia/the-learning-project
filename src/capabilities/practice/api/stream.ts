// M2 (YUK-316) — 练习流 API（handoff 契约：GET /api/practice/stream?date=today）。
// 当日为空时 lazy compose（首次打开练习面）；recompose 是手动重排入口
//（M4 夜链落地后 composer_nightly 接管日常生成，这两个入口保留为兜底/调试面）。

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { z } from 'zod';

import { advanceStreamItem, getStream, recomposeStream } from '../server/stream-store';

/** 'today' / 缺省 → 服务器本地日（单用户工具，本地时区即用户时区）。 */
function resolveDate(raw: string | null): string {
  if (raw && raw !== 'today') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new ApiError('validation_error', `invalid date: ${raw}`, 400);
    }
    return raw;
  }
  return new Date().toLocaleDateString('sv-SE');
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const date = resolveDate(url.searchParams.get('date'));
    // 只有「今天」才 lazy compose——翻看历史日期不应凭空生出新流。
    const isToday = date === new Date().toLocaleDateString('sv-SE');
    const view = await getStream(db, date, { composeIfEmpty: isToday });
    return Response.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}

const RecomposeBody = z.object({ date: z.string().optional() });

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => ({}));
    const parsed = RecomposeBody.safeParse(raw);
    if (!parsed.success) throw new ApiError('validation_error', 'invalid body', 400);
    const date = resolveDate(parsed.data.date ?? null);
    const added = await recomposeStream(db, date);
    const view = await getStream(db, date);
    return Response.json({ added, ...view });
  } catch (err) {
    return errorResponse(err);
  }
}

const AdvanceBody = z.object({
  status: z.enum(['pending', 'in_progress', 'done', 'skipped']),
});

export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = AdvanceBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        'status must be one of pending|in_progress|done|skipped',
        400,
      );
    }
    const row = await advanceStreamItem(db, params.id, parsed.data.status);
    if (!row) throw new ApiError('not_found', `stream item ${params.id} not found`, 404);
    return Response.json({ item: row });
  } catch (err) {
    return errorResponse(err);
  }
}
