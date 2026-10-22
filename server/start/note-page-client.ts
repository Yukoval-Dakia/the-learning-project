import {
  type NoteAiChangesClient,
  type NotePageClient,
  NotePageJsonResponseSchema,
  type NoteReferenceSearchClient,
} from '@/capabilities/notes/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import {
  getStartNoteAiChanges,
  getStartNotePage,
  getStartNoteReferences,
} from './note-page-function';

export const startNotePageClient: NotePageClient = async (id) =>
  NotePageJsonResponseSchema.parse(
    JSON.parse(await getStartNotePage({ fetch: authenticatedStartFetch, data: { id } })),
  );

export const startNoteAiChangesClient: NoteAiChangesClient = async (id) =>
  JSON.parse(await getStartNoteAiChanges({ fetch: authenticatedStartFetch, data: { id } }));

export const startNoteReferenceSearchClient: NoteReferenceSearchClient = (q, exclude, signal) =>
  getStartNoteReferences({
    fetch: authenticatedStartFetch,
    data: { q, exclude: exclude || undefined },
    signal,
  });
