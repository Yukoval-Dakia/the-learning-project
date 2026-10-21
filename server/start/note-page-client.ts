import { type NotePageClient, NotePageJsonResponseSchema } from '@/capabilities/notes/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartNotePage } from './note-page-function';

export const startNotePageClient: NotePageClient = async (id) =>
  NotePageJsonResponseSchema.parse(
    JSON.parse(await getStartNotePage({ fetch: authenticatedStartFetch, data: { id } })),
  );
