import {
  type NoteAiChangesClient,
  type NotePageClient,
  NotePageJsonResponseSchema,
} from '@/capabilities/notes/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartNoteAiChanges, getStartNotePage } from './note-page-function';

export const startNotePageClient: NotePageClient = async (id) =>
  NotePageJsonResponseSchema.parse(
    JSON.parse(await getStartNotePage({ fetch: authenticatedStartFetch, data: { id } })),
  );

export const startNoteAiChangesClient: NoteAiChangesClient = async (id) =>
  JSON.parse(await getStartNoteAiChanges({ fetch: authenticatedStartFetch, data: { id } }));
