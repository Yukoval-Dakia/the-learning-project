import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { FrontdoorContext } from './context';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const saveStartResponseDraftFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<FrontdoorContext['saveResponseDraft']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.saveResponseDraft(data)),
    ),
  );
