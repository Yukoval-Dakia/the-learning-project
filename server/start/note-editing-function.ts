import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const heartbeatStartNoteEditingFunction = createServerFn({ method: 'POST' })
  .validator((body: string) => body)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { heartbeatStartNoteEditing } = await import('./note-editing-operation');
      return JSON.stringify(await heartbeatStartNoteEditing(data));
    }),
  );

export const blurStartNoteEditingFunction = createServerFn({ method: 'POST' })
  .validator((body: string) => body)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { blurStartNoteEditing } = await import('./note-editing-operation');
      return JSON.stringify(await blurStartNoteEditing(data));
    }),
  );
