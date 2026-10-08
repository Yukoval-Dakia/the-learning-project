import type { Hono } from 'hono';
import type { MistakeListQuery, MistakeListResponse } from '@/capabilities/ingestion/public';

export type FrontdoorContext = {
  api: Hono;
  readMistakes: (input: MistakeListQuery) => Promise<MistakeListResponse>;
  legacySpa: Hono;
  startAssets: Hono;
};

declare module '@tanstack/react-router' {
  interface Register {
    server: { requestContext: FrontdoorContext };
  }
}
