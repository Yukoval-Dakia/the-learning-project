import type { Hono } from 'hono';
import type { submitConjectureProbeAnswer } from '@/capabilities/agency/public';
import type {
  cancelCopilotRun,
  createCopilotSession,
  dismissCopilotNudge,
  loadActiveNudges,
  loadCopilotSummary,
  markCopilotNudgeOpened,
  readCopilotSessions,
  readCopilotTurns,
  requestCopilotChat,
  requestCopilotCheckpointRevert,
  requestTeachingChipAcceptance,
} from '@/capabilities/copilot/public';
import type { AdminControlClient } from '@/capabilities/observability/ui/admin-control-client';
import type {
  getIssuanceState,
  readJudgeRunStatus,
  requestAssessmentIssuance,
  requestResponseDraftSave,
  requestReviewAnswer,
  revealFrozenStudyReference,
} from '@/capabilities/practice/grading/public';
import type {
  PlacementProfileResponse,
  readPlacementSession,
  releaseHeldPlacement,
  selectNextPlacementQuestion,
  startPlacementProbe,
  transitionPlacementSession,
} from '@/capabilities/practice/placement/public';
import type {
  createPracticeHintRequest,
  createPracticeSolveSession,
} from '@/capabilities/practice/public';
import type { previewReviewAdvice } from '@/capabilities/practice/scheduling/public';
import type {
  createPracticePaperSubmission,
  createReviewSession,
  getPaperDetail,
  readPaperList,
  readWorksheetExport,
  transitionReviewSession,
} from '@/capabilities/practice/session/public';

export type FrontdoorContext = {
  api: Hono;
  acceptTeachingChip: (input: {
    sessionId: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof requestTeachingChipAcceptance>>>;
  sendCopilotChat: (
    input: { body: string; key: string | null },
    signal: AbortSignal,
  ) => Promise<Awaited<ReturnType<typeof requestCopilotChat>>>;
  revertCopilotCheckpoint: (
    checkpointEventId: string,
  ) => Promise<Awaited<ReturnType<typeof requestCopilotCheckpointRevert>>>;
  cancelCopilotRun: (runId: string) => Promise<Awaited<ReturnType<typeof cancelCopilotRun>>>;
  readCopilotTurns: (query: string) => Promise<Awaited<ReturnType<typeof readCopilotTurns>>>;
  createCopilotSession: () => Promise<Awaited<ReturnType<typeof createCopilotSession>>>;
  readCopilotSessions: () => Promise<Awaited<ReturnType<typeof readCopilotSessions>>>;
  dismissCopilotNudge: (id: string) => Promise<Awaited<ReturnType<typeof dismissCopilotNudge>>>;
  markCopilotNudgeOpened: (
    id: string,
  ) => Promise<Awaited<ReturnType<typeof markCopilotNudgeOpened>>>;
  readCopilotNudges: () => Promise<{ nudges: Awaited<ReturnType<typeof loadActiveNudges>> }>;
  readCopilotSummary: () => Promise<Awaited<ReturnType<typeof loadCopilotSummary>>>;
  adminControls: () => Promise<AdminControlClient>;
  submitConjectureProbeAnswer: (
    input: { probeId: string; body: string },
    signal: AbortSignal,
  ) => Promise<Awaited<ReturnType<typeof submitConjectureProbeAnswer>>>;
  startPlacement: (body: string) => Promise<Awaited<ReturnType<typeof startPlacementProbe>>>;
  readPlacementSession: typeof readPlacementSession;
  selectNextPlacementQuestion: (
    sessionId: string,
  ) => Promise<Awaited<ReturnType<typeof selectNextPlacementQuestion>>>;
  releaseHeldPlacement: (input: {
    sessionId: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof releaseHeldPlacement>>>;
  readPapers: () => Promise<Awaited<ReturnType<typeof readPaperList>>>;
  submitPaperSlot: (input: {
    sessionId: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof createPracticePaperSubmission>>>;
  endPaperSession: (sessionId: string) => Promise<{
    id: string;
    type: 'review';
    previous_status: Awaited<ReturnType<typeof transitionReviewSession>>['previousStatus'];
    status: Awaited<ReturnType<typeof transitionReviewSession>>['status'];
    changed: boolean;
    allowed_statuses: Awaited<ReturnType<typeof transitionReviewSession>>['allowedStatuses'];
  }>;
  startPaperSession: (
    body: string,
  ) => Promise<{ session_id: Awaited<ReturnType<typeof createReviewSession>>['sessionId'] }>;
  readPaperDetail: (
    artifactId: string,
  ) => Promise<NonNullable<Awaited<ReturnType<typeof getPaperDetail>>>>;
  createIssuance: (body: string) => ReturnType<typeof requestAssessmentIssuance>;
  readIssuanceState: (issuanceId: string) => Promise<Awaited<ReturnType<typeof getIssuanceState>>>;
  saveResponseDraft: (input: {
    issuanceId: string;
    body: string;
  }) => ReturnType<typeof requestResponseDraftSave>;
  readJudgeRunStatus: (
    runId: string,
  ) => Promise<Extract<Awaited<ReturnType<typeof readJudgeRunStatus>>, { kind: 'found' }>['value']>;
  transitionPlacementSession: (input: {
    sessionId: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof transitionPlacementSession>>>;
  createSolveSession: (
    body: string,
  ) => Promise<Awaited<ReturnType<typeof createPracticeSolveSession>>>;
  createHintRequest: (input: {
    sessionId: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof createPracticeHintRequest>>>;
  revealStudyReference: (
    issuanceId: string,
  ) => Promise<Awaited<ReturnType<typeof revealFrozenStudyReference>>>;
  createPracticeAppeal: (body: string) => Promise<string>;
  previewReviewAdvice: (
    body: string,
    signal: AbortSignal,
  ) => Promise<Awaited<ReturnType<typeof previewReviewAdvice>>>;
  submitPlacementAnswer: (
    body: string,
    signal: AbortSignal,
  ) => Promise<Awaited<ReturnType<typeof requestReviewAnswer>>['body']>;
  readPlacementProfile: (goalId: string) => Promise<PlacementProfileResponse>;
  readWorksheetExport: (
    token: string,
  ) => Promise<NonNullable<Awaited<ReturnType<typeof readWorksheetExport>>>>;
  startAssets: Hono;
};

declare module '@tanstack/react-router' {
  interface Register {
    server: { requestContext: FrontdoorContext };
  }
}
