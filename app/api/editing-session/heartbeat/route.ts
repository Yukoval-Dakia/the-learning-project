import { z } from 'zod';

import { db } from '@/db/client';
import { recordEditingHeartbeat } from '@/server/artifacts/editing-session';
import { enqueueDwellNoteRefine } from '@/server/artifacts/note-refine-triggers';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

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
    recordEditingHeartbeat({ artifactId: body.artifact_id, status: body.status });
    if (body.status === 'editing') {
      await enqueueDwellNoteRefine({ db, artifactId: body.artifact_id });
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
