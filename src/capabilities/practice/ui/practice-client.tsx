import { createContext, useContext } from 'react';
import type { ApiOperationJsonResponse } from '@/ui/lib/api';
import {
  advanceStreamItem,
  fileAppeal,
  getAdvice,
  getIssuanceState,
  getPaperDetail,
  getPapers,
  getQuestionFull,
  getStream,
  issueAssessment,
  recomposeStream,
  revealStudyReference,
  saveResponseDraft,
  solveHint,
  solveStart,
  submitReview,
} from './practice-api';

export type PracticeClient = {
  getPaperDetail: typeof getPaperDetail;
  solveStart: typeof solveStart;
  solveHint: typeof solveHint;
  revealStudyReference: typeof revealStudyReference;
  fileAppeal: typeof fileAppeal;
  advanceStreamItem: typeof advanceStreamItem;
  getAdvice: typeof getAdvice;
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
  getPaperDetail,
  solveStart,
  solveHint,
  revealStudyReference,
  fileAppeal,
  getAdvice,
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
