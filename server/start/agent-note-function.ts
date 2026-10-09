import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { AgentNoteBoardQuery } from '@/capabilities/agency/public';
import { runAuthenticatedStartAgentNoteBoard } from './agent-note-read';

// Identity only: canonical input validation must run after token and epoch authorization.
export const getStartAgentNoteBoard = createServerFn({ method: 'GET' })
  .inputValidator((input: AgentNoteBoardQuery) => input)
  .handler(({ context, data }) => runAuthenticatedStartAgentNoteBoard(context, getRequest(), data));
