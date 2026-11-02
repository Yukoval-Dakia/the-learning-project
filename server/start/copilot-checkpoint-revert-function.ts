import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const revertStartCopilotCheckpointFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { checkpointEventId: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const outcome = await context.revertCopilotCheckpoint(data.checkpointEventId);
      if (outcome.status !== 200) {
        throw Response.json(outcome.body, { status: outcome.status });
      }
      return JSON.stringify(outcome.body);
    }),
  );
