// YUK-325 — 恢复 M5 teardown 时退役的单事件只读面。
// [id] 由 capability 组合根转换为 Hono :id 参数；事件解析、纠正状态和一跳因果链
// 继续复用 event single-owner reader，避免在 API 层重写 event 查询语义。

import { db } from '@/db/client';
import { getEventChain } from '@/kernel/events';
import { getEventById } from '@/kernel/events';
import { ApiError, errorResponse } from '@/server/http/errors';
import { EventParamsSchema } from './event-contracts';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = EventParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'event id is required', 400);
    }

    const { id } = parsed.data;
    const focal = await getEventById(db, id);
    if (!focal) {
      throw new ApiError('not_found', `event ${id} not found`, 404);
    }

    const chain = await getEventChain(db, id);
    return Response.json({ event: focal, correction_status: focal.correction_status, chain });
  } catch (error) {
    return errorResponse(error);
  }
}
