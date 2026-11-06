import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { FrontdoorAdapters, FrontdoorContext } from './context';
import type { StartEventOptions } from './event-adapters';
import { runAuthenticatedStartWorkbench } from './workbench-read';

type EventStartContext = Pick<FrontdoorContext, 'api'> & {
  adapters: Pick<FrontdoorAdapters, 'event'>;
};

export function runAuthenticatedStartEventDetail(
  context: EventStartContext,
  request: Request,
  input: unknown,
  options?: StartEventOptions,
) {
  return runAuthenticatedStartWorkbench(context, request, async () => {
    const { readStartEventDetail } = await context.adapters.event();
    return readStartEventDetail(input, options);
  });
}

export function runAuthenticatedStartEventCorrection(
  context: EventStartContext,
  request: Request,
  input: unknown,
  options?: StartEventOptions,
) {
  return runAuthenticatedStartWorkbench(context, request, async () => {
    const { createStartEventCorrection } = await context.adapters.event();
    return createStartEventCorrection(input, options);
  });
}

// Identity leaves unknown input parsing after token and active epoch authorization.
// JSON protects arbitrary payload/passthrough keys from Seroval object reconstruction.
export const getStartEventDetail = createServerFn({ method: 'GET' })
  .validator((input: unknown) => input)
  .handler(async ({ context, data }) =>
    JSON.stringify(await runAuthenticatedStartEventDetail(context, getRequest(), data)),
  );

export const postStartEventCorrection = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartEventCorrection(context, getRequest(), data),
  );
