// YUK-519 (A7) — GET /api/observability/effectiveness-trend（只读）。
// per-KC / per-subject 纵向成效趋势观测面，沿 calibration-maturity.ts 的读模型 → 路由形态
// （db + errorResponse + Response.json）。/api/* token 校验由组合根中间件统一施加。
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

import { loadEffectivenessTrend } from '../server/effectiveness-trend';

export async function GET(): Promise<Response> {
  try {
    const result = await loadEffectivenessTrend(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
