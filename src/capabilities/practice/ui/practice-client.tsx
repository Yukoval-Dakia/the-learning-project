import { createContext, useContext } from 'react';
import type { ApiOperationJsonResponse } from '@/ui/lib/api';
import {
  advanceStreamItem,
  getIssuanceState,
  getPapers,
  getStream,
  issueAssessment,
  saveResponseDraft,
  submitReview,
} from './practice-api';

export type PracticeClient = {
  advanceStreamItem: typeof advanceStreamItem;
  getStream: typeof getStream;
  getPapers: typeof getPapers;
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
  getIssuanceState,
  getPapers,
  issueAssessment,
  saveResponseDraft,
  submitReview,
};
const PracticeClientContext = createContext<PracticeClient | undefined>(undefined);
export const PracticeClientProvider = PracticeClientContext.Provider;
export function usePracticeClient(): PracticeClient {
  return useContext(PracticeClientContext) ?? httpPracticeClient;
}
