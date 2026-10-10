import { createStartAdminReader } from './admin-reader';
import type { FrontdoorContext } from './context';
import { runAuthenticatedStartWorkbench } from './workbench-read';

// Do not create the reader, import domain operations or acquire the DB before auth.
export function runAuthenticatedStartAdmin<T>(
  context: Pick<FrontdoorContext, 'api'>,
  request: Request,
  operation: (reader: Awaited<ReturnType<typeof createStartAdminReader>>) => Promise<T>,
  options?: Parameters<typeof createStartAdminReader>[0],
): Promise<T> {
  return runAuthenticatedStartWorkbench(context, request, async () =>
    operation(await createStartAdminReader(options)),
  );
}
