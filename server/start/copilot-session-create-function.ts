import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseStatus } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const createStartCopilotSessionFunction = createServerFn({ method: 'POST' }).handler(
  ({ context }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () => {
      const result = await context.createCopilotSession();
      setResponseStatus(result.status);
      return JSON.stringify(result.body);
    }),
);
