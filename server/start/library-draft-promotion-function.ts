import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const enableStartLibraryDraftFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.enableLibraryDraft(data.id)),
    ),
  );

export const forceEnableStartLibraryDraftFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string; body: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.forceEnableLibraryDraft(data)),
    ),
  );
