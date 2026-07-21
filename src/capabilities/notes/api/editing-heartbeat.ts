// M5-T5a (YUK-321)：平移自 app/api/editing-session/heartbeat/route.ts（Hono
// manifest 挂载；旧壳 Task 9 拆）。
// YUK-358 决定6 (ADR-0040)：dwell note_refine 触发已裁撤 / dwell trigger retired。
// 本路由退化为纯 presence 写——只 recordEditingHeartbeat 喂 editing_presence DEFER
// 仲裁（决定1 A-track auto-apply 依赖它），不再 enqueue 任何 note_refine。

import { EditingHeartbeatBodySchema } from '@/capabilities/notes/api/contracts';
import { db } from '@/db/client';
import {
  markArtifactIdleAndFlush,
  recordEditingHeartbeat,
} from '@/server/artifacts/editing-session';
import { ApiError, errorResponse } from '@/server/http/errors';

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = EditingHeartbeatBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const body = parsed.data;
    // W2 — honour `status`. 'idle' is a BLUR: remove only this editor's session (and flush
    // the deferred queue only once NO active session remains), matching the /blur route's
    // old idle=clear-presence semantics. The route previously ignored status and
    // reverse-upserted an 'idle' request into an ACTIVE session (inverted). 'editing' upserts
    // the per-session heartbeat row. ('idle' is retained in the wire contract for Task-5
    // back-compat; new clients only send 'editing'.)
    if (body.status === 'idle') {
      await markArtifactIdleAndFlush({
        db,
        artifactId: body.artifact_id,
        sessionId: body.editor_session_id,
      });
    } else {
      await recordEditingHeartbeat({
        artifactId: body.artifact_id,
        sessionId: body.editor_session_id,
      });
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
