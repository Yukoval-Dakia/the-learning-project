import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { SECURITY_HEADERS } from './app';
import type { FrontdoorContext } from './start/context';

export function buildLegacySpa(root: string): Hono {
  const spa = new Hono();
  spa.use('*', SECURITY_HEADERS);
  spa.use('*', serveStatic({ root }));
  // Missing assets must not masquerade as an HTML document (or run stale chunks).
  spa.get('/assets/*', (c) => c.notFound());
  spa.get('/_build/*', (c) => c.notFound());
  spa.get('*', serveStatic({ root, path: 'index.html' }));
  return spa;
}

export async function createFrontdoor(api: Hono, spaRoot: string) {
  const entry = await import('../dist/start/server/server.js');
  const startAssets = new Hono();
  startAssets.use(
    '/_build/*',
    serveStatic({
      root: 'dist/start/client',
      rewriteRequestPath: (path) => path.replace(/^\/_build/, ''),
    }),
  );
  const context: FrontdoorContext = { api, legacySpa: buildLegacySpa(spaRoot), startAssets };
  const frontdoor = new Hono();
  frontdoor.use('*', SECURITY_HEADERS);
  frontdoor.all('*', (c) => entry.default.fetch(c.req.raw, { context }));
  return (request: Request) => frontdoor.fetch(request);
}
