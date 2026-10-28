import { createContext, useContext } from 'react';
import {
  answerAsk,
  createSession,
  createWrongAnswer,
  getHistory,
  getSession,
  listBlocks,
  listKnowledge,
  listSessions,
  revertBlock,
} from './record-api';

export type RecordClient = {
  getHistory: typeof getHistory;
  answerAsk: typeof answerAsk;
  listSessions: typeof listSessions;
  listKnowledge: typeof listKnowledge;
  listBlocks: typeof listBlocks;
  createSession: typeof createSession;
  getSession: typeof getSession;
  createWrongAnswer: typeof createWrongAnswer;
  revertBlock: typeof revertBlock;
};
const httpRecordClient: RecordClient = {
  getHistory,
  answerAsk,
  listSessions,
  listKnowledge,
  listBlocks,
  createSession,
  getSession,
  createWrongAnswer,
  revertBlock,
};
const RecordClientContext = createContext<RecordClient | undefined>(undefined);
export const RecordClientProvider = RecordClientContext.Provider;
export function useRecordClient(): RecordClient {
  return useContext(RecordClientContext) ?? httpRecordClient;
}
