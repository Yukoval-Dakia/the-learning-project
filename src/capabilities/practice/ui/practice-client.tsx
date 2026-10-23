import { createContext, useContext } from 'react';
import type { ApiOperationJsonResponse } from '@/ui/lib/api';
import {
  advanceStreamItem,
  getIssuanceState,
  getPapers,
  getQuestionFull,
  getStream,
  issueAssessment,
  recomposeStream,
  saveResponseDraft,
  submitReview,
} from './practice-api';

export type PracticeClient = {
  advanceStreamItem: typeof advanceStreamItem;
  getStream: typeof getStream;
  recomposeStream: typeof recomposeStream;
  getPapers: typeof getPapers;
  getQuestionDetail: (id: string) => ReturnType<typeof getQuestionFull>;
  issueAssessment: typeof issueAssessment;
  getIssuanceState: typeof getIssuanceState;
  saveResponseDraft: typeof saveResponseDraft;
  submitReview: typeof submitReview;
  /** Absent over HTTP: the existing poller follows the receipt's poll_url. */
  readJudgeRunStatus?: (runId: string) => Promise<ApiOperationJsonResponse<'getJudgeRunStatus'>>;
};
const httpPracticeClient: PracticeClient = {
  advanceStreamItem,
  getStream,
  recomposeStream,
  getIssuanceState,
  getPapers,
  getQuestionDetail: (id) => getQuestionFull(id, { surface: 'practice' }),
  issueAssessment,
  saveResponseDraft,
  submitReview,
};
const PracticeClientContext = createContext<PracticeClient | undefined>(undefined);
export const PracticeClientProvider = PracticeClientContext.Provider;
export function usePracticeClient(): PracticeClient {
  return useContext(PracticeClientContext) ?? httpPracticeClient;
}
