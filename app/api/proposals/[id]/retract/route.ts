// M4 review fix (YUK-319, codex P2)：旧壳 learning-items 详情页（YUK-19 retract
// CTA）仍 fetch Next 同 origin 的 /api/proposals/[id]/retract——T7 拆壳时漏了
// 这个跨面消费者。shim 直接复用 shell 包 kernel v2 handler，零逻辑分叉；
// learning-items 页 M5 迁 SPA 时随旧壳一起删除本文件。

import { POST as retract } from '@/capabilities/shell/api/proposal-retract';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  return retract(req, { id });
}
