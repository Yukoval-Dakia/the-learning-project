import type { Hono } from 'hono';
import type { MistakeListQuery, MistakeListResponse } from '@/capabilities/ingestion/public';
import type { AdminControlClient } from '@/capabilities/observability/ui/admin-control-client';
import type {
  PlacementProfileResponse,
  readPlacementSession,
  transitionPlacementSession,
} from '@/capabilities/practice/public';
import type { LearnerSubjectRow } from '@/capabilities/shell/public';

export type FrontdoorContext = {
  api: Hono;
  adminControls: () => Promise<AdminControlClient>;
  readPlacementSession: typeof readPlacementSession;
  transitionPlacementSession: (input: {
    sessionId: string;
    body: string;
  }) => Promise<Awaited<ReturnType<typeof transitionPlacementSession>>>;
  readSubjects: () => Promise<{ subjects: LearnerSubjectRow[] }>;
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
