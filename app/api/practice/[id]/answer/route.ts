// 外壳挂载 — handler 本体在 practice capability 包（M2 上 Hono，YUK-316）。
// param 路由 shim：Next ctx.params (Promise) 解包为 kernel RouteHandler v2 的
// params Record。双栈期保留至 M2-T7 拆除。
import { POST as handler } from '@/capabilities/practice/api/paper-answer-route';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handler(req, await ctx.params);
}
