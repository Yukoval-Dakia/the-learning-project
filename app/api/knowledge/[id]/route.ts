// 外壳挂载 — handler 本体在 knowledge capability 包（M3 上 Hono，YUK-317）。
// param 路由 shim：Next ctx.params (Promise) 解包为 kernel RouteHandler v2 的
// params Record。双栈期保留至 M3-T8 拆除。
import { GET as GETHandler } from '@/capabilities/knowledge/api/node-page-route';

export const runtime = 'nodejs';

export async function GET(
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
): Promise<Response> {
  return GETHandler(req, await ctx.params);
}
