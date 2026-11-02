import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const createStartSolveSessionFunction = createServerFn({ method: 'POST' })
  .inputValidator((body: string) => body)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.createSolveSession(data)),
    ),
  );

export const createStartHintRequestFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { sessionId: string; body: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.createHintRequest(data)),
    ),
  );
