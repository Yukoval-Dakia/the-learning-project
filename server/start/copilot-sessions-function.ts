import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartCopilotSessionsFunction = createServerFn({ method: 'GET' }).handler(
  ({ context }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const result = await context.readCopilotSessions();
      for (const [name, value] of Object.entries(result.headers)) setResponseHeader(name, value);
      return JSON.stringify(result.body);
    }),
);
