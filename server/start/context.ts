import type { Hono } from 'hono';
import type { createGoal } from '@/capabilities/agency/public';
import type { createIngestionSession, readMistakes } from '@/capabilities/ingestion/public';
import type {
  createManualKnowledgeEdge,
  loadKnowledgeNodePage,
  loadMisconceptionsForKc,
  readKnowledgeEdges,
} from '@/capabilities/knowledge/public';
import type { thinCreateSubject } from '@/capabilities/observability/public';
import type { AdminControlClient } from '@/capabilities/observability/ui/admin-control-client';
import type {
  PlacementProfileResponse,
  archivePracticeQuestion,
  createPracticeHintRequest,
  createPracticePaperSubmission,
  createPracticeSolveSession,
  createReviewSession,
  enablePracticeDraft,
  forceEnablePracticeDraft,
  getIssuanceState,
  getPaperDetail,
  getPracticeStream,
  previewReviewAdvice,
  projectIssuanceResult,
  projectReviewAnswerResponse,
  readDraftReviewDetail,
  readJudgeRunStatus,
  readPaperList,
  readPlacementSession,
  readQuestionDetail,
  recomposePracticeStream,
  releaseHeldPlacement,
  restorePracticeQuestion,
  revealFrozenStudyReference,
  runPracticeServingAction,
  saveResponseDraft,
  selectNextPlacementQuestion,
  startPlacementProbe,
  transitionPlacementSession,
  transitionReviewSession,
  updatePracticeQuestion,
  updatePracticeStreamItem,
} from '@/capabilities/practice/public';
import type { LearnerSubjectRow } from '@/capabilities/shell/public';

export type FrontdoorContext = {
  api: Hono;
  enableLibraryDraft: (id: string) => Promise<Awaited<ReturnType<typeof enablePracticeDraft>>>;
  forceEnableLibraryDraft: (input: {
    id: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof forceEnablePracticeDraft>>>;
  runLibraryServingAction: (input: {
    path: string;
    idempotencyKey: string | null;
  }) => Promise<Awaited<ReturnType<typeof runPracticeServingAction>>>;
  adminControls: () => Promise<AdminControlClient>;
  createIngestionSession: (input: {
    body: string;
    key: string | null;
  }) => Promise<
    Extract<Awaited<ReturnType<typeof createIngestionSession>>, { body: { session: unknown } }>
  >;
  createKnowledgeEdge: (
    body: string,
  ) => Promise<Awaited<ReturnType<typeof createManualKnowledgeEdge>>>;
  readKnowledgeEdges: (subject?: string) => Promise<Awaited<ReturnType<typeof readKnowledgeEdges>>>;
  readKnowledgeNodePage: (
    id: string,
  ) => Promise<NonNullable<Awaited<ReturnType<typeof loadKnowledgeNodePage>>>>;
  readKnowledgeMisconceptions: (id: string) => Promise<{
    rows: Awaited<ReturnType<typeof loadMisconceptionsForKc>>;
  }>;
  createGoal: (body: string) => Promise<Awaited<ReturnType<typeof createGoal>>>;
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
  readLibraryDraftDetail: (
    id: string,
  ) => Promise<Awaited<ReturnType<typeof readDraftReviewDetail>>>;
  readLibraryQuestionMistakes: (id: string) => Promise<Awaited<ReturnType<typeof readMistakes>>>;
  restoreLibraryQuestion: (input: {
    id: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof restorePracticeQuestion>>>;
  updateLibraryQuestion: (input: {
    id: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof updatePracticeQuestion>>>;
  archiveLibraryQuestion: (input: {
    id: string;
    query: string;
  }) => Promise<Awaited<ReturnType<typeof archivePracticeQuestion>>>;
  readLibraryQuestionDetail: (
    id: string,
  ) => Promise<Awaited<ReturnType<typeof readQuestionDetail>>>;
  readPracticeQuestionDetail: (
    id: string,
  ) => Promise<Awaited<ReturnType<typeof readQuestionDetail>>>;
  getPracticeStream: (
    knowledgeId?: string,
  ) => Promise<Awaited<ReturnType<typeof getPracticeStream>>>;
  recomposePracticeStream: () => Promise<Awaited<ReturnType<typeof recomposePracticeStream>>>;
  updatePracticeStreamItem: (input: {
    id: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof updatePracticeStreamItem>>>;
  createIssuance: (body: string) => Promise<ReturnType<typeof projectIssuanceResult>>;
  readIssuanceState: (issuanceId: string) => Promise<Awaited<ReturnType<typeof getIssuanceState>>>;
  saveResponseDraft: (input: {
    issuanceId: string;
    body: string;
  }) => Promise<Extract<Awaited<ReturnType<typeof saveResponseDraft>>, { status: 'saved' }>>;
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
  ) => Promise<ReturnType<typeof projectReviewAnswerResponse>['body']>;
  readSubjects: () => Promise<{ subjects: LearnerSubjectRow[] }>;
  createSubject: (
    displayName: string,
  ) => Promise<
    Extract<
      Awaited<ReturnType<typeof thinCreateSubject>>,
      { kind: 'created' | 'replayed' }
    >['payload']
  >;
  readPlacementProfile: (goalId: string) => Promise<PlacementProfileResponse>;
  legacySpa: Hono;
  startAssets: Hono;
};

declare module '@tanstack/react-router' {
  interface Register {
    server: { requestContext: FrontdoorContext };
  }
}
