import type { FrontdoorContext } from './context';
import { authorizeStartFunction } from './start';

export async function readAuthenticatedStartMistakes(
  context: Pick<FrontdoorContext, 'api' | 'readMistakes'>,
  request: Request,
  input: Parameters<FrontdoorContext['readMistakes']>[0],
) {
  const denied = await authorizeStartFunction(context.api, request);
  if (denied) throw denied;
  return context.readMistakes(input);
}
