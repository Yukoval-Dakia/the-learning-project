import { createContext, useContext } from 'react';
import { createSession, getSession, listBlocks, listKnowledge, listSessions } from './record-api';

export type RecordClient = {
  listSessions: typeof listSessions;
  listKnowledge: typeof listKnowledge;
  listBlocks: typeof listBlocks;
  createSession: typeof createSession;
  getSession: typeof getSession;
};
const httpRecordClient: RecordClient = {
  listSessions,
  listKnowledge,
  listBlocks,
  createSession,
  getSession,
};
const RecordClientContext = createContext<RecordClient | undefined>(undefined);
export const RecordClientProvider = RecordClientContext.Provider;
export function useRecordClient(): RecordClient {
  return useContext(RecordClientContext) ?? httpRecordClient;
}
