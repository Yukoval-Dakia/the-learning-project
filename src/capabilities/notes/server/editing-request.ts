import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { EditingBlurBodySchema, EditingHeartbeatBodySchema } from '../api/contracts';
import { markArtifactIdleAndFlush, recordEditingHeartbeat } from './artifacts/editing-session';

function validationError(issues: { path: PropertyKey[]; message: string }[]) {
  return new ApiError(
    'validation_error',
    issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    400,
  );
}

/** Own the complete heartbeat request: validation plus the presence write. */
export async function requestEditingHeartbeat(db: Db, loadBody: () => Promise<unknown>) {
  const parsed = EditingHeartbeatBodySchema.safeParse(await loadBody().catch(() => null));
  if (!parsed.success) throw validationError(parsed.error.issues);
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
  return { ok: true };
}

/** Own the complete blur request: clear this editor's presence and flush deferred work. */
export async function requestEditingBlur(db: Db, loadBody: () => Promise<unknown>) {
  const parsed = EditingBlurBodySchema.safeParse(await loadBody().catch(() => null));
  if (!parsed.success) throw validationError(parsed.error.issues);
  return markArtifactIdleAndFlush({
    db,
    artifactId: parsed.data.artifact_id,
    sessionId: parsed.data.editor_session_id,
  });
}
