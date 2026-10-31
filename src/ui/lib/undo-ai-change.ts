import { ApiError, type ApiOperationJsonResponse, apiOperationJson } from './api';

export type UndoAiChangeResult = ApiOperationJsonResponse<'undoArtifactAiChange'>;

// The undo route answers HTTP 200 even when it did not restore the note.
// A concurrent version bump is `skipped:version_conflict` (unchanged);
// `skipped:already_undone` is a real no-op and stays resolved.
export function rejectUndoVersionConflict<T extends { status: string }>(result: T): T {
  if (result.status === 'skipped:version_conflict') {
    throw new ApiError('undo skipped: version_conflict', 409, 'version_conflict');
  }
  return result;
}

export const undoAiChange = async (
  artifactId: string,
  eventId: string,
): Promise<UndoAiChangeResult> => {
  const artifact = encodeURIComponent(artifactId);
  const event = encodeURIComponent(eventId);
  const result = await apiOperationJson('undoArtifactAiChange', {
    url: `/api/artifacts/${artifact}/ai-changes/${event}/undo`,
    method: 'POST',
  });
  return rejectUndoVersionConflict(result);
};
