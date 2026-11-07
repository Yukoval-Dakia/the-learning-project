// Start-side adapters for this family. `frontdoor.ts` loads this module from the API
// graph, so every adapter below runs with the initialized subject registry, config
// snapshot and database pool; each keeps its own conversion, error and deadline handling.

import type { NoteListQuery } from '@/capabilities/notes/public';
import type { Db, Tx } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

// Called after token/epoch authorization. Notes owns validation and the presence write.
export async function heartbeatStartNoteEditing(body: string) {
  try {
    const { requestEditingHeartbeat } = await import('@/capabilities/notes/public');
    const { db } = await import('@/db/client');
    return await requestEditingHeartbeat(db, async () => JSON.parse(body));
  } catch (error) {
    throw errorResponse(error);
  }
}

export async function blurStartNoteEditing(body: string) {
  try {
    const { requestEditingBlur } = await import('@/capabilities/notes/public');
    const { db } = await import('@/db/client');
    return await requestEditingBlur(db, async () => JSON.parse(body));
  } catch (error) {
    throw errorResponse(error);
  }
}

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

export async function readStartNoteAiChanges(
  input: { id: string },
  options: { database?: Db } = {},
) {
  try {
    const { listArtifactAiChanges } = await import('@/capabilities/notes/public');
    const database = options.database ?? (await import('@/db/client')).db;
    return await listArtifactAiChanges(database, input?.id);
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

// Called after token/epoch authorization. Notes owns the complete edit,
// including row lock, version conflict, history, projection and backlinks.
export async function saveStartNoteBody(
  input: { id: string; body: string },
  options: { database?: Db } = {},
) {
  try {
    const { EditArtifactBodyBlocksBodySchema, editArtifactBodyBlocks } = await import(
      '@/capabilities/notes/public'
    );
    if (typeof input?.id !== 'string' || !input.id) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    let rawBody: unknown = null;
    try {
      rawBody = JSON.parse(input.body);
    } catch {
      // Match the retained HTTP handler's malformed-JSON validation path.
    }
    const parsed = EditArtifactBodyBlocksBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const database = options.database ?? (await import('@/db/client')).db;
    return await editArtifactBodyBlocks({
      db: database,
      artifactId: input.id,
      expectedArtifactVersion: parsed.data.artifact_version,
      bodyBlocks: parsed.data.body_blocks,
    });
  } catch (error) {
    throw errorResponse(error);
  }
}

// Auth runs before this reader imports the domain or the default database.
export async function readStartNoteList(
  input: NoteListQuery,
  options: { database?: Db | Tx } = {},
) {
  try {
    const { NoteListQuerySchema, loadNoteList } = await import('@/capabilities/notes/public');
    const parsed = NoteListQuerySchema.safeParse(input);
    if (!parsed.success) throw Response.json({ error: 'validation_error' }, { status: 400 });
    const database = options.database ?? (await import('@/db/client')).db;
    return await loadNoteList(database, parsed.data);
  } catch (error) {
    // Shape errors inside the Start ESM bundle before the CJS host boundary.
    throw error instanceof Response ? error : errorResponse(error);
  }
}

export async function readStartNoteEntityCard(id: string) {
  try {
    const { readNoteEntityCard } = await import('@/capabilities/notes/public');
    const { db } = await import('@/db/client');
    return await readNoteEntityCard(db, id);
  } catch (error) {
    throw errorResponse(error);
  }
}

export const notesAdapters = {
  blurStartNoteEditing,
  heartbeatStartNoteEditing,
  readStartNoteAiChanges,
  readStartNoteEntityCard,
  readStartNoteList,
  readStartNotePage,
  saveStartNoteBody,
  searchStartNoteReferences,
};
