// 外壳挂载 — handler 本体在 ingestion capability 包（架构重写 M1，YUK-314）。
// param 路由 shim：把 Next 的 ctx.params (Promise) 解包成 kernel RouteHandler v2
// 的 params Record。双栈期保留，T7 拆除。
import { GET as handler } from '@/capabilities/ingestion/api/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handler(req, await ctx.params);
}
