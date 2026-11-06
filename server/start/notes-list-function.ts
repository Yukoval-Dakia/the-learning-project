import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { NoteListQuery } from '@/capabilities/notes/public';
import { runAuthenticatedStartWorkbench } from './workbench-read';

// Identity only: validation must follow token and epoch authorization.
export const getStartNoteList = createServerFn({ method: 'GET' })
  .validator((input: NoteListQuery) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { readStartNoteList } = await context.adapters.notes();
      return readStartNoteList(data);
    }),
  );
