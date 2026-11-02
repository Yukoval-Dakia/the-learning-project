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
import { createStartGoal } from './start/goal-create-operation';
import { createStartIngestionOperation } from './start/ingestion-operation-create-operation';
import { createStartIngestionSession } from './start/ingestion-session-create-operation';
import { createStartIssuance } from './start/issuance-create-operation';
import { readStartIssuanceState } from './start/issuance-state-reader';
import { readStartJudgeRunStatus } from './start/judge-status-reader';
import { createStartKnowledgeEdge } from './start/knowledge-edge-create-operation';
import { readStartKnowledgeEdges } from './start/knowledge-edges-reader';
import { readStartKnowledgeMisconceptions } from './start/knowledge-misconceptions-reader';
import { readStartKnowledgeNodePage } from './start/knowledge-node-reader';
import { createStartLearningIntent } from './start/learning-intent-operation';
import { readStartLibraryDraftDetail } from './start/library-draft-detail-reader';
import { readStartLibraryDrafts } from './start/library-draft-list-reader';
import {
  enableStartLibraryDraft,
  forceEnableStartLibraryDraft,
} from './start/library-draft-promotion-operation';
import { readStartLibraryMistakes } from './start/library-mistake-list-reader';
import { archiveStartLibraryQuestion } from './start/library-question-delete-operation';
import { readStartLibraryQuestionDetail } from './start/library-question-detail-reader';
import { readStartLibraryQuestions } from './start/library-question-list-reader';
import { readStartLibraryQuestionMistakes } from './start/library-question-mistakes-reader';
import { restoreStartLibraryQuestion } from './start/library-question-restore-operation';
import { updateStartLibraryQuestion } from './start/library-question-update-operation';
import { runStartLibraryServingAction } from './start/library-serving-action-operation';
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
import { readStartPracticeQuestionDetail } from './start/practice-question-detail-operation';
import { updateStartPracticeStreamItem } from './start/practice-stream-item-operation';
import { getStartPracticeStream } from './start/practice-stream-operation';
import { recomposeStartPracticeStream } from './start/practice-stream-recompose-operation';
import { answerStartConjectureProbe } from './start/probe-answer-operation';
import { readStartPlacementProfile } from './start/profile-reader';
import { answerStartRecordAsk } from './start/record-ask-answer-operation';
import { readStartRecordBlocks } from './start/record-blocks-reader';
import { createStartRecordManualMistake } from './start/record-manual-mistake-operation';
import { changeStartRecordPurpose } from './start/record-purpose-change-operation';
import { readStartRecordPurposeImpact } from './start/record-purpose-impact-reader';
import { revertStartRecordBlock } from './start/record-revert-operation';
import { readStartRecordSessionDetail } from './start/record-session-detail-reader';
import { readStartRecordSessionHistory } from './start/record-session-history-reader';
import { readStartRecordSessions } from './start/record-session-list-reader';
import { saveStartResponseDraft } from './start/response-draft-operation';
import { createStartHintRequest, createStartSolveSession } from './start/solve-operation';
import { revealStartStudyReference } from './start/study-reference-operation';
import { createStartSubject } from './start/subject-create-operation';
import { readStartSubjects } from './start/subject-reader';
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
    createIngestionSession: createStartIngestionSession,
    createIngestionOperation: createStartIngestionOperation,
    answerRecordAsk: answerStartRecordAsk,
    changeRecordPurpose: changeStartRecordPurpose,
    readRecordPurposeImpact: readStartRecordPurposeImpact,
    readRecordBlocks: readStartRecordBlocks,
    createRecordManualMistake: createStartRecordManualMistake,
    revertRecordBlock: revertStartRecordBlock,
    readRecordSessionDetail: readStartRecordSessionDetail,
    readRecordSessionHistory: readStartRecordSessionHistory,
    readRecordSessions: readStartRecordSessions,
    readPapers: readStartPapers,
    startPaperSession,
    submitPaperSlot: submitStartPaperSlot,
    endPaperSession: endStartPaperSession,
    readPaperDetail: readStartPaperDetail,
    readPracticeQuestionDetail: readStartPracticeQuestionDetail,
    readLibraryQuestionDetail: readStartLibraryQuestionDetail,
    readLibraryQuestions: readStartLibraryQuestions,
    readLibraryQuestionMistakes: readStartLibraryQuestionMistakes,
    readLibraryMistakes: readStartLibraryMistakes,
    restoreLibraryQuestion: restoreStartLibraryQuestion,
    updateLibraryQuestion: updateStartLibraryQuestion,
    runLibraryServingAction: runStartLibraryServingAction,
    archiveLibraryQuestion: archiveStartLibraryQuestion,
    readLibraryDraftDetail: readStartLibraryDraftDetail,
    readLibraryDrafts: readStartLibraryDrafts,
    enableLibraryDraft: enableStartLibraryDraft,
    forceEnableLibraryDraft: forceEnableStartLibraryDraft,
    getPracticeStream: getStartPracticeStream,
    recomposePracticeStream: recomposeStartPracticeStream,
    updatePracticeStreamItem: updateStartPracticeStreamItem,
    createKnowledgeEdge: createStartKnowledgeEdge,
    readKnowledgeEdges: readStartKnowledgeEdges,
    readKnowledgeMisconceptions: readStartKnowledgeMisconceptions,
    readKnowledgeNodePage: readStartKnowledgeNodePage,
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
    readSubjects: readStartSubjects,
    revealStudyReference: revealStartStudyReference,
    createSolveSession: createStartSolveSession,
    createHintRequest: createStartHintRequest,
    createPracticeAppeal: createStartPracticeAppeal,
    previewReviewAdvice: previewStartReviewAdvice,
    submitPlacementAnswer: submitStartPlacementAnswer,
    createSubject: createStartSubject,
    createGoal: createStartGoal,
    createLearningIntent: createStartLearningIntent,
    submitConjectureProbeAnswer: answerStartConjectureProbe,
    startAssets,
  };
  return context;
}

export async function createFrontdoor(api: Hono) {
  const entry = await import('../dist/start/server/server.js');
  const context = createFrontdoorContext(api);
  const frontdoor = new Hono();
  frontdoor.use('*', SECURITY_HEADERS);
  for (const path of ROOT_PUBLIC_FILES)
    frontdoor.get(path, serveStatic({ root: START_CLIENT_ROOT }));
  frontdoor.all('*', (c) => entry.default.fetch(c.req.raw, { context }));
  return (request: Request) => frontdoor.fetch(request);
}
