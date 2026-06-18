// YUK-348 (B1) — GET /api/observability/calibration-maturity（只读）。
// per-KC mastery-calibration firm-up 观测面，沿 admin-cost.ts 的读模型 → 路由形态
// （db + errorResponse + Response.json）。/api/* token 校验由组合根中间件统一施加。
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

import { loadCalibrationMaturity } from '../server/calibration-maturity';

export async function GET(): Promise<Response> {
  try {
    const result = await loadCalibrationMaturity(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
