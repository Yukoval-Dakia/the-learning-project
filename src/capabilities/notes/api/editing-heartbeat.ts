// Presence-only write. Heartbeats no longer trigger note refine; editing
// presence feeds deferred-apply arbitration instead.

import { EditingHeartbeatBodySchema } from '@/capabilities/notes/api/contracts';
import {
  markArtifactIdleAndFlush,
  recordEditingHeartbeat,
} from '@/capabilities/notes/server/artifacts/editing-session';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

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
    // 'idle' means blur: drop this editor's session, and flush deferred work only
    // when no active session remains. New clients send only 'editing'; 'idle'
    // stays in the wire contract for back-compat.
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
