import type { Hono } from 'hono';
import type { createGoal } from '@/capabilities/agency/public';
import type {
  loadKnowledgeNodePage,
  loadMisconceptionsForKc,
  readKnowledgeEdges,
} from '@/capabilities/knowledge/public';
import type { thinCreateSubject } from '@/capabilities/observability/public';
import type { AdminControlClient } from '@/capabilities/observability/ui/admin-control-client';
import type {
  PlacementProfileResponse,
  getIssuanceState,
  projectIssuanceResult,
  projectReviewAnswerResponse,
  readJudgeRunStatus,
  readPaperList,
  readPlacementSession,
  releaseHeldPlacement,
  saveResponseDraft,
  selectNextPlacementQuestion,
  startPlacementProbe,
  transitionPlacementSession,
} from '@/capabilities/practice/public';
import type { LearnerSubjectRow } from '@/capabilities/shell/public';

export type FrontdoorContext = {
  api: Hono;
  adminControls: () => Promise<AdminControlClient>;
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
