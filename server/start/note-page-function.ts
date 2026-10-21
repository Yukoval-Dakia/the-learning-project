import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartNotePage } from './note-page-read';

// Validate after authorization; JSON retains the HTTP wire representation of
// arbitrary block attributes and history timestamps across Seroval.
export const getStartNotePage = createServerFn({ method: 'GET' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ context, data }) =>
    JSON.stringify(await runAuthenticatedStartNotePage(context, getRequest(), data)),
  );
