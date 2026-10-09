import type { AdminControlClient } from '@/capabilities/observability/ui-public';
import type { FrontdoorContext } from './context';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export function runAuthenticatedStartAdminControl<T>(
  context: Pick<FrontdoorContext, 'api' | 'adminControls'>,
  request: Request,
  operation: (controls: AdminControlClient) => Promise<T>,
): Promise<T> {
  return runAuthenticatedStartWorkbench(context, request, async () =>
    operation(await context.adminControls()),
  );
}
