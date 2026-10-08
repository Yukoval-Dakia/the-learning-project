import type { AgentNoteBoardQuery } from '@/capabilities/agency/public';
import { readStartAgentNoteBoard } from './agent-note-reader';
import type { FrontdoorContext } from './context';
import { runAuthenticatedStartWorkbench } from './workbench-read';

export function runAuthenticatedStartAgentNoteBoard(
  context: Pick<FrontdoorContext, 'api'>,
  request: Request,
  input: AgentNoteBoardQuery,
  options?: Parameters<typeof readStartAgentNoteBoard>[1],
) {
  return runAuthenticatedStartWorkbench(context, request, () =>
    readStartAgentNoteBoard(input, options),
  );
}
