import { type AgentNoteClient, AgentNotesResponseSchema } from '@/capabilities/agency/ui-public';
import { getStartAgentNoteBoard } from './agent-note-function';
import { authenticatedStartFetch } from './authenticated-fetch';

export const startAgentNoteClient: AgentNoteClient = {
  getAgentNoteBoard: async (limit) =>
    AgentNotesResponseSchema.parse(
      await getStartAgentNoteBoard({ fetch: authenticatedStartFetch, data: { limit } }),
    ),
};
