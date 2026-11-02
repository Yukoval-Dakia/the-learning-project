import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartCopilotTurnsFunction = createServerFn({ method: 'GET' })
  .inputValidator((query: string) => query)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.readCopilotTurns(data)),
    ),
  );
