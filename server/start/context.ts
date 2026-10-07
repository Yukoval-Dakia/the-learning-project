import type { Hono } from 'hono';

export type FrontdoorContext = {
  api: Hono;
  legacySpa: Hono;
  startAssets: Hono;
};

declare module '@tanstack/react-router' {
  interface Register {
    server: { requestContext: FrontdoorContext };
  }
}
