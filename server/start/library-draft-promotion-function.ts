import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const enableStartLibraryDraftFunction = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { enableStartLibraryDraft } = await import('./library-draft-promotion-operation');
      return JSON.stringify(await enableStartLibraryDraft(data.id));
    }),
  );

export const forceEnableStartLibraryDraftFunction = createServerFn({ method: 'POST' })
  .validator((input: { id: string; body: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const { forceEnableStartLibraryDraft } = await import('./library-draft-promotion-operation');
      return JSON.stringify(await forceEnableStartLibraryDraft(data));
    }),
  );
