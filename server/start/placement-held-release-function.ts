import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { FrontdoorContext } from './context';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export const releaseStartHeldPlacementFunction = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<FrontdoorContext['releaseHeldPlacement']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartWorkbench(context, getRequest(), async () =>
      JSON.stringify(await context.releaseHeldPlacement(data)),
    ),
  );
