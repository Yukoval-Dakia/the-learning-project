import type { Db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

// Invoked only after token/epoch authorization; reuse the HTTP route's reader
// and input contract rather than reconstructing its aggregate here.
export async function readStartNotePage(input: { id: string }, options: { database?: Db } = {}) {
  try {
    const { NoteIdParamsSchema, loadNotePage } = await import('@/capabilities/notes/public');
    const parsed = NoteIdParamsSchema.safeParse(input);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'note id is required', 400);
    }
    const database = options.database ?? (await import('@/db/client')).db;
    const page = await loadNotePage(database, parsed.data.id);
    if (!page) {
      throw new ApiError('not_found', `note ${parsed.data.id} not found`, 404);
    }
    return page;
  } catch (error) {
    // Preserve the HTTP ApiError payload across the Start ESM/CJS boundary.
    throw errorResponse(error);
  }
}

// Keep the retained HTTP history selection: this artifact, newest 50 changes.
// Notes owns ordering and undo correlation; do not infer them from page history.
export async function readStartNoteAiChanges(
  input: { id: string },
  options: { database?: Db } = {},
) {
  try {
    if (typeof input?.id !== 'string' || !input.id) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    const { listNoteRefineChanges } = await import('@/capabilities/notes/public');
    const database = options.database ?? (await import('@/db/client')).db;
    const rows = await listNoteRefineChanges(database, { artifactId: input.id, limit: 50 });
    return { artifact_id: input.id, rows };
  } catch (error) {
    throw errorResponse(error);
  }
}

export async function searchStartNoteReferences(
  input: { q: string; exclude?: string },
  options: { database?: Db } = {},
) {
  try {
    const { searchArtifactReferences } = await import('@/capabilities/notes/public');
    const database = options.database ?? (await import('@/db/client')).db;
    return await searchArtifactReferences(database, { q: input?.q, exclude: input?.exclude });
  } catch (error) {
    throw errorResponse(error);
  }
}
