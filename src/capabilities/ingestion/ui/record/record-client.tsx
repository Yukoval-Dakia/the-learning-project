import { createContext, useContext } from 'react';
import { listSessions } from './record-api';

export type RecordClient = {
  listSessions: typeof listSessions;
};
const httpRecordClient: RecordClient = { listSessions };
const RecordClientContext = createContext<RecordClient | undefined>(undefined);
export const RecordClientProvider = RecordClientContext.Provider;
export function useRecordClient(): RecordClient {
  return useContext(RecordClientContext) ?? httpRecordClient;
}
