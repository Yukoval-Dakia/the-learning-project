import { createContext, useContext } from 'react';
import type { ApiOperationJsonResponse } from '@/ui/lib/api';
import { getIssuanceState, getPapers, saveResponseDraft } from './practice-api';

export type PracticeClient = {
  getPapers: typeof getPapers;
  getIssuanceState: typeof getIssuanceState;
  saveResponseDraft: typeof saveResponseDraft;
  /** Absent over HTTP: the existing poller follows the receipt's poll_url. */
  readJudgeRunStatus?: (runId: string) => Promise<ApiOperationJsonResponse<'getJudgeRunStatus'>>;
};
const httpPracticeClient: PracticeClient = { getIssuanceState, getPapers, saveResponseDraft };
const PracticeClientContext = createContext<PracticeClient | undefined>(undefined);
export const PracticeClientProvider = PracticeClientContext.Provider;
export function usePracticeClient(): PracticeClient {
  return useContext(PracticeClientContext) ?? httpPracticeClient;
}
