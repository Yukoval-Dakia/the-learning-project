import { createContext, useContext } from 'react';
import { listKnowledge, listSessions } from './record-api';

export type RecordClient = {
  listSessions: typeof listSessions;
  listKnowledge: typeof listKnowledge;
};
const httpRecordClient: RecordClient = { listSessions, listKnowledge };
const RecordClientContext = createContext<RecordClient | undefined>(undefined);
export const RecordClientProvider = RecordClientContext.Provider;
export function useRecordClient(): RecordClient {
  return useContext(RecordClientContext) ?? httpRecordClient;
}
