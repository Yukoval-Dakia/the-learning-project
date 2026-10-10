import { type NoteListClient, NoteListResponseSchema } from '@/capabilities/notes/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartNoteList } from './notes-list-function';

export const startNoteListClient: NoteListClient = async (subject, query) =>
  NoteListResponseSchema.parse(
    await getStartNoteList({
      fetch: authenticatedStartFetch,
      data: { subject: subject || undefined, query: query?.trim() || undefined },
    }),
  );
