import { type ReactNode, createContext, useContext, useMemo } from 'react';
import type { ApiOperationJsonResponse } from '@/ui/lib/api';
import {
  advanceStreamItem,
  endPaperSession,
  fileAppeal,
  getAdvice,
  getIssuanceState,
  getPaperDetail,
  getPapers,
  getQuestionFull,
  getStream,
  issueAssessment,
  pausePaperTask,
  recomposeStream,
  recordPaperCurrentStep,
  restoreHints,
  resumePaperTask,
  revealStudyReference,
  saveResponseDraft,
  solveHint,
  solveStart,
  startPaperSession,
  submitPaperSlot,
  submitReview,
} from './practice-api';

export type PracticeClient = {
  restoreHints: typeof restoreHints;
  submitPaperSlot: typeof submitPaperSlot;
  endPaperSession: typeof endPaperSession;
  startPaperSession: typeof startPaperSession;
  getPaperDetail: typeof getPaperDetail;
  resumePaperTask: typeof resumePaperTask;
  pausePaperTask: typeof pausePaperTask;
  recordPaperCurrentStep: typeof recordPaperCurrentStep;
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
  restoreHints,
  submitPaperSlot,
  endPaperSession,
  startPaperSession,
  getPaperDetail,
  resumePaperTask,
  pausePaperTask,
  recordPaperCurrentStep,
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
export function PracticeClientProvider({
  value,
  children,
}: {
  value: Partial<PracticeClient>;
  children: ReactNode;
}) {
  const client = useMemo<PracticeClient>(
    () => ({
      ...httpPracticeClient,
      ...value,
      // Artifact-only Start readers cannot resolve a clicked session occurrence.
      getPaperDetail: (artifactId, taskRef) =>
        taskRef
          ? getPaperDetail(artifactId, taskRef)
          : (value.getPaperDetail ?? getPaperDetail)(artifactId),
    }),
    [value],
  );
  return <PracticeClientContext.Provider value={client}>{children}</PracticeClientContext.Provider>;
}
export function usePracticeClient(): PracticeClient {
  return useContext(PracticeClientContext) ?? httpPracticeClient;
}
