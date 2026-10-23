import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const readStartPaperDetailFunction = createServerFn({ method: 'GET' })
  .inputValidator((artifactId: string) => artifactId)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.readPaperDetail(data)),
    ),
  );
