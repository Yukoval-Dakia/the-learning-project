// YUK-579 — GET /api/admin/coverage-lattice (只读). 供题治理覆盖细目表：scanCoverageGaps 四规则
// 的 KC 池级覆盖 + emitted 缺口 targets（desired kind×band×tier 坐标）+ MF1 供给活动注记。
// READ-ONLY：零写、零 LLM。沿 conjecture-scores.ts 读模型 → 薄 route 形态；/api/* token 校验由
// 组合根中间件统一施加。
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { loadCoverageLattice } from '../server/coverage-lattice';

export async function GET(): Promise<Response> {
  try {
    const result = await loadCoverageLattice(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
