import type { Hono } from 'hono';
import type { MistakeListQuery, MistakeListResponse } from '@/capabilities/ingestion/public';
import type { thinCreateSubject } from '@/capabilities/observability/public';
import type { AdminControlClient } from '@/capabilities/observability/ui/admin-control-client';
import type {
  PlacementProfileResponse,
  getIssuanceState,
  readJudgeRunStatus,
  readPaperList,
  readPlacementSession,
  releaseHeldPlacement,
  saveResponseDraft,
  selectNextPlacementQuestion,
  transitionPlacementSession,
} from '@/capabilities/practice/public';
import type { LearnerSubjectRow } from '@/capabilities/shell/public';

export type FrontdoorContext = {
  api: Hono;
  adminControls: () => Promise<AdminControlClient>;
  readPlacementSession: typeof readPlacementSession;
  selectNextPlacementQuestion: (
    sessionId: string,
  ) => Promise<Awaited<ReturnType<typeof selectNextPlacementQuestion>>>;
  releaseHeldPlacement: (input: {
    sessionId: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof releaseHeldPlacement>>>;
  readPapers: () => Promise<Awaited<ReturnType<typeof readPaperList>>>;
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
  readSubjects: () => Promise<{ subjects: LearnerSubjectRow[] }>;
  createSubject: (
    displayName: string,
  ) => Promise<Extract<Awaited<ReturnType<typeof thinCreateSubject>>, { kind: 'created' | 'replayed' }>['payload']>;
  readPlacementProfile: (goalId: string) => Promise<PlacementProfileResponse>;
  readMistakes: (input: MistakeListQuery) => Promise<MistakeListResponse>;
  legacySpa: Hono;
  startAssets: Hono;
};

declare module '@tanstack/react-router' {
  interface Register {
    server: { requestContext: FrontdoorContext };
  }
}
