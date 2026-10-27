import { createContext, useContext } from 'react';
import { listBlocks, listKnowledge, listSessions } from './record-api';

export type RecordClient = {
  listSessions: typeof listSessions;
  listKnowledge: typeof listKnowledge;
  listBlocks: typeof listBlocks;
};
const httpRecordClient: RecordClient = { listSessions, listKnowledge, listBlocks };
const RecordClientContext = createContext<RecordClient | undefined>(undefined);
export const RecordClientProvider = RecordClientContext.Provider;
export function useRecordClient(): RecordClient {
  return useContext(RecordClientContext) ?? httpRecordClient;
}
