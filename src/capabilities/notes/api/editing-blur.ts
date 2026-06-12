// M5-T5a (YUK-321)：平移自 app/api/editing-session/blur/route.ts（Hono manifest
// 挂载；旧壳 Task 9 拆）。等价平移，行为不动。

import { z } from 'zod';

import { db } from '@/db/client';
import { markArtifactIdleAndFlush } from '@/server/artifacts/editing-session';
import { ApiError, errorResponse } from '@/server/http/errors';

const Body = z.object({
  artifact_id: z.string().min(1),
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
    const result = await markArtifactIdleAndFlush({ db, artifactId: parsed.data.artifact_id });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
