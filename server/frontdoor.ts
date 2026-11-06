import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { SECURITY_HEADERS } from './app';
import { createStartAdminControlReader } from './start/admin-control-reader';
import type { FrontdoorContext } from './start/context';
import { cancelStartCopilotRun } from './start/copilot-cancel-run-operation';
import { sendStartCopilotChat } from './start/copilot-chat-operation';
import { revertStartCopilotCheckpoint } from './start/copilot-checkpoint-revert-operation';
import {
  dismissStartCopilotNudge,
  markStartCopilotNudgeOpened,
} from './start/copilot-nudge-actions-operation';
import { readStartCopilotNudges } from './start/copilot-nudges-reader';
import { createStartCopilotSession } from './start/copilot-session-create-operation';
import { readStartCopilotSessions } from './start/copilot-sessions-reader';
import { readStartCopilotSummary } from './start/copilot-summary-reader';
import { acceptStartTeachingChip } from './start/copilot-teaching-chip-operation';
import { readStartCopilotTurns } from './start/copilot-turns-reader';
import { createStartIssuance } from './start/issuance-create-operation';
import { readStartIssuanceState } from './start/issuance-state-reader';
import { readStartJudgeRunStatus } from './start/judge-status-reader';
import { readStartPaperDetail } from './start/paper-detail-reader';
import { endStartPaperSession } from './start/paper-end-operation';
import { startPaperSession } from './start/paper-start-operation';
import { submitStartPaperSlot } from './start/paper-submit-operation';
import { readStartPapers } from './start/papers-list-reader';
import { releaseStartHeldPlacement } from './start/placement-held-release-operation';
import { selectStartPlacementQuestion } from './start/placement-next-operation';
import { transitionStartPlacementSession } from './start/placement-session-operation';
import { readStartPlacementSession } from './start/placement-session-reader';
import { createStartPlacement } from './start/placement-start-operation';
import { submitStartPlacementAnswer } from './start/placement-submit-operation';
import { previewStartReviewAdvice } from './start/practice-advice-operation';
import { createStartPracticeAppeal } from './start/practice-appeal-operation';
import { answerStartConjectureProbe } from './start/probe-answer-operation';
import { readStartPlacementProfile } from './start/profile-reader';
import { saveStartResponseDraft } from './start/response-draft-operation';
import { createStartHintRequest, createStartSolveSession } from './start/solve-operation';
import { revealStartStudyReference } from './start/study-reference-operation';
import { readStartWorksheetExport } from './start/worksheet-export-reader';

const START_CLIENT_ROOT = 'dist/start/client';

// Files the document <head> and the web manifest request from the site root; vite copies
// public/ into the client output, so they are served from there.
const ROOT_PUBLIC_FILES = [
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/favicon.svg',
];

export function createFrontdoorContext(api: Hono): FrontdoorContext {
  // Cache only the canonical operation bindings. Every call still reads the
  // current facts/store/writer; no configuration snapshot or second writer.
  // The first resolution is requested only after the Start auth/epoch gate.
  let controls: ReturnType<FrontdoorContext['adminControls']> | undefined;
  const startAssets = new Hono();
  startAssets.use(
    '/_build/*',
    serveStatic({
      root: START_CLIENT_ROOT,
      rewriteRequestPath: (path) => path.replace(/^\/_build/, ''),
    }),
  );
  const context: FrontdoorContext = {
    api,
    // Lazy references only; each family module evaluates in this API graph when a
    // Start operation that needs it runs after the auth/epoch gate.
    adapters: {
      library: () => import('./start/library-adapters').then((m) => m.libraryAdapters),
      records: () => import('./start/record-adapters').then((m) => m.recordAdapters),
      knowledge: () => import('./start/knowledge-adapters').then((m) => m.knowledgeAdapters),
      practiceStream: () =>
        import('./start/practice-stream-adapters').then((m) => m.practiceStreamAdapters),
      subjects: () => import('./start/subject-adapters').then((m) => m.subjectAdapters),
      noteEditing: () => import('./start/note-editing-adapters').then((m) => m.noteEditingAdapters),
      workbench: () => import('./start/workbench-adapters').then((m) => m.workbenchAdapters),
    },
    acceptTeachingChip: acceptStartTeachingChip,
    sendCopilotChat: sendStartCopilotChat,
    revertCopilotCheckpoint: revertStartCopilotCheckpoint,
    cancelCopilotRun: cancelStartCopilotRun,
    readCopilotTurns: readStartCopilotTurns,
    createCopilotSession: createStartCopilotSession,
    readCopilotSessions: readStartCopilotSessions,
    dismissCopilotNudge: dismissStartCopilotNudge,
    markCopilotNudgeOpened: markStartCopilotNudgeOpened,
    readCopilotNudges: readStartCopilotNudges,
    readCopilotSummary: readStartCopilotSummary,
    adminControls: () => (controls ??= createStartAdminControlReader()),
    readPapers: readStartPapers,
    startPaperSession,
    submitPaperSlot: submitStartPaperSlot,
    endPaperSession: endStartPaperSession,
    readPaperDetail: readStartPaperDetail,
    createIssuance: createStartIssuance,
    readIssuanceState: readStartIssuanceState,
    readJudgeRunStatus: readStartJudgeRunStatus,
    saveResponseDraft: saveStartResponseDraft,
    startPlacement: createStartPlacement,
    readPlacementSession: readStartPlacementSession,
    selectNextPlacementQuestion: selectStartPlacementQuestion,
    releaseHeldPlacement: releaseStartHeldPlacement,
    transitionPlacementSession: transitionStartPlacementSession,
    readPlacementProfile: readStartPlacementProfile,
    readWorksheetExport: readStartWorksheetExport,
    revealStudyReference: revealStartStudyReference,
    createSolveSession: createStartSolveSession,
    createHintRequest: createStartHintRequest,
    createPracticeAppeal: createStartPracticeAppeal,
    previewReviewAdvice: previewStartReviewAdvice,
    submitPlacementAnswer: submitStartPlacementAnswer,
    submitConjectureProbeAnswer: answerStartConjectureProbe,
    startAssets,
  };
  return context;
}

export type StartEntryFetch = (
  request: Request,
  options: { context: FrontdoorContext },
) => Response | Promise<Response>;

// Shared by the built front door and the Vite dev front door (server/dev-frontdoor.ts) so both
// reach the Hono app through the same request context and security headers.
export function buildFrontdoor(
  api: Hono,
  entryFetch: StartEntryFetch,
  publicRoot: string = START_CLIENT_ROOT,
) {
  const context = createFrontdoorContext(api);
  const frontdoor = new Hono();
  frontdoor.use('*', SECURITY_HEADERS);
  for (const path of ROOT_PUBLIC_FILES) frontdoor.get(path, serveStatic({ root: publicRoot }));
  frontdoor.all('*', (c) => entryFetch(c.req.raw, { context }));
  return (request: Request) => frontdoor.fetch(request);
}

export async function createFrontdoor(api: Hono) {
  const entry = await import('../dist/start/server/server.js');
  return buildFrontdoor(api, (request, options) => entry.default.fetch(request, options));
}
