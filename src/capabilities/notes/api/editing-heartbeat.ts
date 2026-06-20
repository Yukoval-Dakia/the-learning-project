// M5-T5a (YUK-321)：平移自 app/api/editing-session/heartbeat/route.ts（Hono
// manifest 挂载；旧壳 Task 9 拆）。
// YUK-358 决定6 (ADR-0040)：dwell note_refine 触发已裁撤 / dwell trigger retired。
// 本路由退化为纯 presence 写——只 recordEditingHeartbeat 喂 editing_presence DEFER
// 仲裁（决定1 A-track auto-apply 依赖它），不再 enqueue 任何 note_refine。

import { z } from 'zod';

import { recordEditingHeartbeat } from '@/server/artifacts/editing-session';
import { ApiError, errorResponse } from '@/server/http/errors';

const Body = z.object({
  artifact_id: z.string().min(1),
  status: z.enum(['editing', 'idle']),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const body = parsed.data;
    await recordEditingHeartbeat({ artifactId: body.artifact_id, status: body.status });
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
