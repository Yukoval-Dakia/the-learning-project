import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { NoteListQuery } from '@/capabilities/notes/public';
import { runAuthenticatedStartNoteList } from './notes-list-read';

// Identity only: validation must follow token and epoch authorization.
export const getStartNoteList = createServerFn({ method: 'GET' })
  .inputValidator((input: NoteListQuery) => input)
  .handler(({ context, data }) => runAuthenticatedStartNoteList(context, getRequest(), data));
