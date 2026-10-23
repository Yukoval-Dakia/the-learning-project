import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import {
  runAuthenticatedStartNoteAiChanges,
  runAuthenticatedStartNotePage,
  runAuthenticatedStartNoteReferenceSearch,
} from './note-page-read';

// Validate after authorization; JSON retains the HTTP wire representation of
// arbitrary block attributes and history timestamps across Seroval.
export const getStartNotePage = createServerFn({ method: 'GET' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ context, data }) =>
    JSON.stringify(await runAuthenticatedStartNotePage(context, getRequest(), data)),
  );

// Date fields retain the same ISO JSON representation as the old HTTP response.
export const getStartNoteAiChanges = createServerFn({ method: 'GET' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ context, data }) =>
    JSON.stringify(await runAuthenticatedStartNoteAiChanges(context, getRequest(), data)),
  );

export const getStartNoteReferences = createServerFn({ method: 'GET' })
  .inputValidator((input: { q: string; exclude?: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartNoteReferenceSearch(context, getRequest(), data),
  );
