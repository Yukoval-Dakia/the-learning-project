import { createContext, useContext } from 'react';
import { createSession, listBlocks, listKnowledge, listSessions } from './record-api';

export type RecordClient = {
  listSessions: typeof listSessions;
  listKnowledge: typeof listKnowledge;
  listBlocks: typeof listBlocks;
  createSession: typeof createSession;
};
const httpRecordClient: RecordClient = { listSessions, listKnowledge, listBlocks, createSession };
const RecordClientContext = createContext<RecordClient | undefined>(undefined);
export const RecordClientProvider = RecordClientContext.Provider;
export function useRecordClient(): RecordClient {
  return useContext(RecordClientContext) ?? httpRecordClient;
}
