import type {
  NoteEditingBlurClient,
  NoteEditingHeartbeatClient,
} from '@/capabilities/notes/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import {
  blurStartNoteEditingFunction,
  heartbeatStartNoteEditingFunction,
} from './note-editing-function';

export const startNoteEditingHeartbeatClient: NoteEditingHeartbeatClient = async (
  artifactId,
  editorSessionId,
) =>
  JSON.parse(
    await heartbeatStartNoteEditingFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify({
        artifact_id: artifactId,
        editor_session_id: editorSessionId,
        status: 'editing',
      }),
    }),
  );

// The blur is sent while the page may be hiding; keepalive lets it finish.
const keepaliveStartFetch: typeof fetch = (input, init) =>
  authenticatedStartFetch(input, { ...init, keepalive: true });

export const startNoteEditingBlurClient: NoteEditingBlurClient = async (
  artifactId,
  editorSessionId,
) =>
  JSON.parse(
    await blurStartNoteEditingFunction({
      fetch: keepaliveStartFetch,
      data: JSON.stringify({ artifact_id: artifactId, editor_session_id: editorSessionId }),
    }),
  );
