import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { SECURITY_HEADERS } from './app';
import { createStartAdminControlReader } from './start/admin-control-reader';
import type { FrontdoorContext } from './start/context';
import { readStartMistakes } from './start/mistakes-reader';

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

export function createFrontdoorContext(api: Hono, spaRoot: string): FrontdoorContext {
  // Cache only the canonical operation bindings. Every call still reads the
  // current facts/store/writer; no configuration snapshot or second writer.
  // The first resolution is requested only after the Start auth/epoch gate.
  let controls: ReturnType<FrontdoorContext['adminControls']> | undefined;
  const startAssets = new Hono();
  startAssets.use(
    '/_build/*',
    serveStatic({
      root: 'dist/start/client',
      rewriteRequestPath: (path) => path.replace(/^\/_build/, ''),
    }),
  );
  const context: FrontdoorContext = {
    api,
    adminControls: () => (controls ??= createStartAdminControlReader()),
    readMistakes: readStartMistakes,
    legacySpa: buildLegacySpa(spaRoot),
    startAssets,
  };
  return context;
}

export async function createFrontdoor(api: Hono, spaRoot: string) {
  const entry = await import('../dist/start/server/server.js');
  const context = createFrontdoorContext(api, spaRoot);
  const frontdoor = new Hono();
  frontdoor.use('*', SECURITY_HEADERS);
  frontdoor.all('*', (c) => entry.default.fetch(c.req.raw, { context }));
  return (request: Request) => frontdoor.fetch(request);
}
