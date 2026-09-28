// YUK-1007 — GET /api/admin/config：热加载配置读面（view-only）。
//
// 装配逻辑全在 ../server/config-read-model.ts（纯同步、零 DB、复用 store 快照）；
// 本壳只做 HTTP 边界。/api/* token 校验由组合根中间件统一施加（server/app.ts）。
import { errorResponse } from '@/kernel/http';

import { buildAdminConfigReadModel } from '../server/config-read-model';

export async function GET(): Promise<Response> {
  try {
    return Response.json(buildAdminConfigReadModel());
  } catch (err) {
    return errorResponse(err);
  }
}
