import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const cancelStartCopilotRunFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { runId: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.cancelCopilotRun(data.runId)),
    ),
  );
