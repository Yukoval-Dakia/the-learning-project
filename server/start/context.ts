import type { Hono } from 'hono';
import type { MistakeListQuery, MistakeListResponse } from '@/capabilities/ingestion/public';
import type { AdminControlClient } from '@/capabilities/observability/ui/admin-control-client';
import type { LearnerSubjectRow } from '@/capabilities/shell/public';

export type FrontdoorContext = {
  api: Hono;
  adminControls: () => Promise<AdminControlClient>;
  readSubjects: () => Promise<{ subjects: LearnerSubjectRow[] }>;
  readMistakes: (input: MistakeListQuery) => Promise<MistakeListResponse>;
  legacySpa: Hono;
  startAssets: Hono;
};

declare module '@tanstack/react-router' {
  interface Register {
    server: { requestContext: FrontdoorContext };
  }
}
