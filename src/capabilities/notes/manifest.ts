import { MASTERY_PROGRESS_ACTION } from '@/core/schema/event';
import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { nightlyEligibility } from '@/kernel/nightly-eligibility';
import { uiPagesFor } from '@/kernel/ui-surfaces';
import {
  ArtifactAiChangeParamsSchema,
  ArtifactAiChangesResponseSchema,
  ArtifactBacklinksResponseSchema,
  ArtifactIdParamsSchema,
  ArtifactSearchQuerySchema,
  ArtifactSearchResponseSchema,
  EditArtifactBodyBlocksRequestContractSchema,
  EditArtifactBodyBlocksResponseSchema,
  EditingBlurBodySchema,
  EditingBlurResponseSchema,
  EditingHeartbeatBodySchema,
  EditingHeartbeatResponseSchema,
  NoteIdParamsSchema,
  NoteListQuerySchema,
  NoteListResponseSchema,
  NotePageResponseSchema,
  RecentArtifactAiChangesResponseSchema,
  UndoArtifactAiChangeResponseSchema,
} from './api/contracts';

export const notesCapability = defineCapability({
  name: 'notes',
  description:
    '笔记域：artifact 笔记的读（note-page 聚合 / notes-read 按知识点）、写（body-blocks 块编辑 ' +
    '乐观锁 / block-refs 反链索引）与 Living Note refine 链（triggers→policy→' +
    'mutator|propose；信号源 = mastery_change 与错因完成后的 mark_wrong）。',
  subscriptions: {
    handlers: [
      {
        id: 'notes.mastery-progress-note-refine',
        version: 1,
        actions: [MASTERY_PROGRESS_ACTION],
        load: () =>
          import('./server/mastery-progress-subscription').then(
            (m) => m.buildMasteryProgressNoteRefineSubscriber,
          ),
      },
    ],
  },
  api: {
    routes: [
      {
        method: 'GET',
        path: '/api/notes',
        operationId: 'listNotes',
        request: { query: NoteListQuerySchema },
        responses: { 200: NoteListResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/notes-list').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/notes/[id]',
        operationId: 'getNote',
        request: { params: NoteIdParamsSchema },
        responses: { 200: NotePageResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/note-page-route').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/artifacts/search',
        operationId: 'searchArtifacts',
        request: { query: ArtifactSearchQuerySchema },
        responses: { 200: ArtifactSearchResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/artifacts-search').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/artifacts/ai-changes/recent',
        operationId: 'listRecentArtifactAiChanges',
        responses: { 200: RecentArtifactAiChangesResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/ai-changes-recent').then((m) => m.GET),
      },
      {
        method: 'PATCH',
        path: '/api/artifacts/[id]/body-blocks',
        operationId: 'updateArtifactBodyBlocks',
        request: {
          params: ArtifactIdParamsSchema,
          body: EditArtifactBodyBlocksRequestContractSchema,
        },
        responses: { 200: EditArtifactBodyBlocksResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/body-blocks-route').then((m) => m.PATCH),
      },
      {
        method: 'GET',
        path: '/api/artifacts/[id]/backlinks',
        operationId: 'listArtifactBacklinks',
        request: { params: ArtifactIdParamsSchema },
        responses: { 200: ArtifactBacklinksResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/backlinks').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/artifacts/[id]/ai-changes',
        operationId: 'listArtifactAiChanges',
        request: { params: ArtifactIdParamsSchema },
        responses: { 200: ArtifactAiChangesResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/ai-changes').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/artifacts/[id]/ai-changes/[eventId]/undo',
        operationId: 'undoArtifactAiChange',
        request: { params: ArtifactAiChangeParamsSchema },
        responses: { 200: UndoArtifactAiChangeResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/ai-change-undo').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/editing-session/heartbeat',
        operationId: 'recordEditingHeartbeat',
        request: { body: EditingHeartbeatBodySchema },
        responses: { 200: EditingHeartbeatResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/editing-heartbeat').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/editing-session/blur',
        operationId: 'markEditingSessionIdle',
        request: { body: EditingBlurBodySchema },
        responses: { 200: EditingBlurResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/editing-blur').then((m) => m.POST),
      },
    ],
  },
  jobs: {
    handlers: [
      {
        // Coverage repair only: dirties or cancels cursors; the reconciler owns
        // every apply. Batch layer (ADR-0067 D2): dormant learners skip coverage
        // repair; presence hygiene must still run before that decision.
        name: 'hub_auto_sync_nightly',
        schedule: { cron: '45 2 * * *', tz: 'Asia/Shanghai' },
        eligibility: nightlyEligibility('deterministic'),
        beforeEligibility: async (db) => {
          const { reapAbandonedEditSessions } = await import('./server/artifacts/presence/pg');
          await reapAbandonedEditSessions(db);
        },
        queue: 'llm',
        load: () =>
          import('./jobs/hub_auto_sync_nightly').then((m) => m.buildHubAutoSyncNightlyHandler),
      },
      {
        name: 'hub_sync_recovery',
        schedule: { cron: '* * * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/hub_auto_sync_nightly').then((m) => m.buildHubSyncRecoveryJobHandler),
      },
      {
        // Best-effort wake after a topology commit; the reconciler dedupes and
        // applies, so a lost wake only waits for the recovery floor.
        name: 'hub_sync_mutation_wake',
        queue: 'llm',
        load: () =>
          import('./jobs/hub_auto_sync_nightly').then((m) => m.buildHubSyncMutationWakeJobHandler),
      },
      {
        name: 'note_refine',
        queue: 'llm',
        load: () => import('./jobs/note-refine').then((m) => m.buildNoteRefineHandler),
      },
      {
        name: 'note_generate',
        queue: 'llm',
        load: () => import('./jobs/note_generate').then((m) => m.buildNoteGenerateHandler),
      },
    ],
  },
  // The accept shell validates and orchestrates; the persist body stays in
  // note-refine-apply.
  proposals: {
    kinds: [
      {
        kind: 'note_update',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.noteUpdateProposalAcceptApplier,
            ),
        },
        retract: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.noteUpdateProposalRetractApplier,
            ),
        },
      },
    ],
  },
  // YUK-1769 — write_note is the companion's direct Markdown note write
  // (create / append / note_generate handoff). Notes owns it; Copilot holds
  // only the allowlist surface grant.
  copilotTools: {
    tools: [
      {
        name: 'write_note',
        load: () => import('./server/tools/write-note').then((m) => m.writeNoteTool),
      },
      {
        name: 'check_note',
        load: () => import('./server/tools/check-note').then((m) => m.checkNoteTool),
      },
      {
        name: 'read_note',
        load: () => import('./server/tools/read-note').then((m) => m.readNoteTool),
      },
    ],
  },
  ui: { pages: uiPagesFor('notes') },
});
