// conjecture-wire #13 (YUK-538 ⑬ / spec §6 S4) — GET /api/admin/conjecture-scores (只读).
// Admin observation surface for the conjecture calibration loop: prediction_score
// LOG events (honest brier/log_loss/skill_score_point) + auto-minted kc_typed_state
// confused-with-X rows (A4 fix — the structural state reconcile mints silently).
// /api/* token 校验由组合根中间件统一施加；沿 calibration-maturity.ts 读模型 → 路由形态。
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { loadConjectureScores } from '../server/conjecture-scores';

export async function GET(): Promise<Response> {
  try {
    const result = await loadConjectureScores(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
