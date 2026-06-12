// M5-T5a (YUK-321)：平移自 app/api/editing-session/heartbeat/route.ts（Hono
// manifest 挂载；旧壳 Task 9 拆）。dwell ⚖️ 争议行未裁——等价平移，行为不动。

import { z } from 'zod';

import { enqueueDwellNoteRefine } from '@/capabilities/notes/server/note-refine-triggers';
import { db } from '@/db/client';
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
    if (body.status === 'editing') {
      await enqueueDwellNoteRefine({ db, artifactId: body.artifact_id });
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
