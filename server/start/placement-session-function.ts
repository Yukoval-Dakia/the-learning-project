import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { FrontdoorContext } from './context';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const getStartPlacementSession = createServerFn({ method: 'GET' })
  .inputValidator((sessionId: string) => sessionId)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.readPlacementSession(data)),
    ),
  );

export const updateStartPlacementSession = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<FrontdoorContext['transitionPlacementSession']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.transitionPlacementSession(data)),
    ),
  );
