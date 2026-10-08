// YUK-1007 — GET /api/admin/config：热加载配置读面（view-only）。
//
// 装配逻辑全在 ../server/config-read-model.ts（纯同步、零 DB、复用 store 快照
// + 组合根注入的运行时事实 providers[]/infra schedules/runtime/effective）；
// 本壳只做 HTTP 边界。/api/* token 校验由组合根中间件统一施加（server/app.ts）。
import { errorResponse } from '@/kernel/http';

import { buildAdminConfigReadModel, getAdminConfigRuntimeFacts } from '../public';

export async function GET(): Promise<Response> {
  try {
    return Response.json(buildAdminConfigReadModel(process.env, getAdminConfigRuntimeFacts()));
  } catch (err) {
    return errorResponse(err);
  }
}
