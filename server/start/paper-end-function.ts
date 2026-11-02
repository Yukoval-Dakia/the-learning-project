import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const endPaperSessionFunction = createServerFn({ method: 'POST' })
  .inputValidator((sessionId: string) => sessionId)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.endPaperSession(data)),
    ),
  );
