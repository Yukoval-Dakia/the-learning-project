import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartLibraryDraftsFunction = createServerFn({ method: 'GET' })
  .inputValidator((query: string) => query)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.readLibraryDrafts(data)),
    ),
  );
