import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { SECURITY_HEADERS } from './app';
import { createStartAdminControlReader } from './start/admin-control-reader';
import type { FrontdoorContext } from './start/context';
import { readStartIssuanceState } from './start/issuance-state-reader';
import { readStartJudgeRunStatus } from './start/judge-status-reader';
import { readStartMistakes } from './start/mistakes-reader';
import { readStartPapers } from './start/papers-list-reader';
import { releaseStartHeldPlacement } from './start/placement-held-release-operation';
import { selectStartPlacementQuestion } from './start/placement-next-operation';
import { transitionStartPlacementSession } from './start/placement-session-operation';
import { readStartPlacementSession } from './start/placement-session-reader';
import { submitStartPlacementAnswer } from './start/placement-submit-operation';
import { readStartPlacementProfile } from './start/profile-reader';
import { saveStartResponseDraft } from './start/response-draft-operation';
import { createStartSubject } from './start/subject-create-operation';
import { readStartSubjects } from './start/subject-reader';

export function buildLegacySpa(root: string): Hono {
  const spa = new Hono();
  spa.use('*', SECURITY_HEADERS);
  spa.use('*', serveStatic({ root }));
  // Missing assets must not masquerade as an HTML document (or run stale chunks).
  spa.get('/assets/*', (c) => c.notFound());
  spa.get('/_build/*', (c) => c.notFound());
  for (const asset of [
    '/manifest.webmanifest',
    '/apple-touch-icon.png',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-maskable-512.png',
    '/favicon.svg',
  ]) {
    spa.get(asset, (c) => c.notFound());
  }
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
    readPapers: readStartPapers,
    readIssuanceState: readStartIssuanceState,
    readJudgeRunStatus: readStartJudgeRunStatus,
    saveResponseDraft: saveStartResponseDraft,
    readPlacementSession: readStartPlacementSession,
    selectNextPlacementQuestion: selectStartPlacementQuestion,
    releaseHeldPlacement: releaseStartHeldPlacement,
    transitionPlacementSession: transitionStartPlacementSession,
    readPlacementProfile: readStartPlacementProfile,
    readSubjects: readStartSubjects,
    submitPlacementAnswer: submitStartPlacementAnswer,
    createSubject: createStartSubject,
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
