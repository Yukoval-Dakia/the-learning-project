import { createContext, useContext } from 'react';
import { apiJson } from '@/ui/lib/api';
import type { AgentNotesResponse } from './types';

export type AgentNoteClient = {
  getAgentNoteBoard: (limit: number) => Promise<AgentNotesResponse>;
};
export const httpAgentNoteClient: AgentNoteClient = {
  getAgentNoteBoard: (limit) => apiJson<AgentNotesResponse>(`/api/agents/notes?limit=${limit}`),
};
const AgentNoteClientContext = createContext<AgentNoteClient | undefined>(undefined);
export const AgentNoteClientProvider = AgentNoteClientContext.Provider;

export function useAgentNoteClient(): AgentNoteClient {
  return useContext(AgentNoteClientContext) ?? httpAgentNoteClient;
}
