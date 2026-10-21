// Blur clears this editor's presence and flushes deferred work once no session
// remains.

import { EditingBlurBodySchema } from '@/capabilities/notes/api/contracts';
import { markArtifactIdleAndFlush } from '@/capabilities/notes/server/artifacts/editing-session';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = EditingBlurBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const result = await markArtifactIdleAndFlush({
      db,
      artifactId: parsed.data.artifact_id,
      sessionId: parsed.data.editor_session_id,
    });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
