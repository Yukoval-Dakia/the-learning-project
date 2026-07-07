// YUK-573 — GET /api/admin/judge-calibration (只读). Admin observation surface
// for the judge disagreement-sampling loop: agreement rate (MIN_N-gated,
// same_lane-excluded headline) + per-route / per-outcome strata + recent runs
// (mass-skip discriminator). /api/* token 校验由组合根中间件统一施加；沿
// conjecture-scores.ts 读模型 → 薄路由形态。无前端 UI（owner design pre-flight）。
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { loadJudgeCalibrationStats } from '../server/judge-calibration';

export async function GET(): Promise<Response> {
  try {
    const result = await loadJudgeCalibrationStats(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
