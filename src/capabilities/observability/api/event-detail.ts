// YUK-325 — 恢复 M5 teardown 时退役的单事件只读面。
// [id] 由 capability 组合根转换为 Hono :id 参数；事件解析、纠正状态和一跳因果链
// 继续复用 event single-owner reader，避免在 API 层重写 event 查询语义。

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { readEventDetail } from '../server/event-detail';
import { EventParamsSchema } from './event-contracts';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = EventParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'event id is required', 400);
    }

    return Response.json(await readEventDetail(db, parsed.data.id));
  } catch (error) {
    return errorResponse(error);
  }
}
