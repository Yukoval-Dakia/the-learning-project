import type { FrontdoorContext } from './context';
import type { StartEventOptions } from './event-operation';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export function runAuthenticatedStartEventDetail(
  context: Pick<FrontdoorContext, 'api'>,
  request: Request,
  input: unknown,
  options?: StartEventOptions,
) {
  return runAuthenticatedStartWorkbench(context, request, async () => {
    const { readStartEventDetail } = await import('./event-operation');
    return readStartEventDetail(input, options);
  });
}

export function runAuthenticatedStartEventCorrection(
  context: Pick<FrontdoorContext, 'api'>,
  request: Request,
  input: unknown,
  options?: StartEventOptions,
) {
  return runAuthenticatedStartWorkbench(context, request, async () => {
    const { createStartEventCorrection } = await import('./event-operation');
    return createStartEventCorrection(input, options);
  });
}
