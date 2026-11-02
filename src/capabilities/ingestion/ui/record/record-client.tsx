import { createContext, useContext } from 'react';
import {
  answerAsk,
  changePurpose,
  createSession,
  createWrongAnswer,
  getHistory,
  getPurposeImpact,
  getSession,
  listBlocks,
  listKnowledge,
  listSessions,
  revertBlock,
  startLane,
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
  startLane: typeof startLane;
  getPurposeImpact: typeof getPurposeImpact;
  changePurpose: typeof changePurpose;
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
  startLane,
  getPurposeImpact,
  changePurpose,
};
const RecordClientContext = createContext<RecordClient | undefined>(undefined);
export const RecordClientProvider = RecordClientContext.Provider;
export function useRecordClient(): RecordClient {
  return useContext(RecordClientContext) ?? httpRecordClient;
}
