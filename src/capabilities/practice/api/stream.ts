// 练习流 API: GET /api/practice/stream?date=today.
// 当日为空时 lazy compose；recompose 是手动重排入口（夜间 composer 接管日常生成，
// 这两个入口保留为兜底/调试面）。
//
// 本文件只为 Request/Response 适配；校验与编排在
// `../server/stream-operations.ts`，供其他 live consumer 复用。

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import {
  getPracticeStream,
  recomposePracticeStream,
  updatePracticeStreamItem,
} from '../server/stream-operations';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const view = await getPracticeStream(db, Object.fromEntries(url.searchParams));
    return Response.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => ({}));
    const result = await recomposePracticeStream(db, raw);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const result = await updatePracticeStreamItem(db, params.id, raw);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
