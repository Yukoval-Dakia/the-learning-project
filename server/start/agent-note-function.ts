import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { AgentNoteBoardQuery } from '@/capabilities/agency/public';
import type { AgentNoteBoardOptions } from './agent-note-adapters';
import type { FrontdoorAdapters, FrontdoorContext } from './context';
import { runAuthenticatedStartWorkbench } from './workbench-read';

type AgentNoteStartContext = Pick<FrontdoorContext, 'api'> & {
  adapters: Pick<FrontdoorAdapters, 'agentNote'>;
};

export function runAuthenticatedStartAgentNoteBoard(
  context: AgentNoteStartContext,
  request: Request,
  input: AgentNoteBoardQuery,
  options?: AgentNoteBoardOptions,
) {
  return runAuthenticatedStartWorkbench(context, request, async () => {
    const { readStartAgentNoteBoard } = await context.adapters.agentNote();
    return readStartAgentNoteBoard(input, options);
  });
}

// Identity only: canonical input validation must run after token and epoch authorization.
export const getStartAgentNoteBoard = createServerFn({ method: 'GET' })
  .validator((input: AgentNoteBoardQuery) => input)
  .handler(({ context, data }) => runAuthenticatedStartAgentNoteBoard(context, getRequest(), data));
