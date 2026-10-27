import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const dismissStartCopilotNudgeFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.dismissCopilotNudge(data.id)),
    ),
  );

export const markStartCopilotNudgeOpenedFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.markCopilotNudgeOpened(data.id)),
    ),
  );
