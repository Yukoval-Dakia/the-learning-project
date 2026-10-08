import type { FrontdoorContext } from './context';
import { authorizeStartFunction } from './start';

// Called by every operation as well as the global request/function middleware.
// No reader, command, connection or provider import runs before token + epoch auth.
export async function runAuthenticatedStartWorkbench<T>(
  context: Pick<FrontdoorContext, 'api'>,
  request: Request,
  operation: () => Promise<T>,
): Promise<T> {
  const denied = await authorizeStartFunction(context.api, request);
  if (denied) throw denied;
  return operation();
}
