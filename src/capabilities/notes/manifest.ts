import { MASTERY_PROGRESS_ACTION } from '@/core/schema/event';
import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { nightlyEligibility } from '@/kernel/nightly-eligibility';
import { uiPagesFor } from '@/kernel/ui-surfaces';
import {
  ArtifactAiChangeParamsSchema,
  ArtifactAiChangesResponseSchema,
  ArtifactBacklinksResponseSchema,
  ArtifactCorrectionStateResponseSchema,
  ArtifactIdParamsSchema,
  ArtifactSearchQuerySchema,
  ArtifactSearchResponseSchema,
  ArtifactSectionParamsSchema,
  CorrectArtifactBodySchema,
  CreateArtifactCorrectionResponseSchema,
  DismissHubLinkBodySchema,
  DismissHubLinkResponseSchema,
  EditArtifactBodyBlocksRequestContractSchema,
  EditArtifactBodyBlocksResponseSchema,
  EditArtifactSectionBodySchema,
  EditArtifactSectionResponseSchema,
  EditingBlurBodySchema,
  EditingBlurResponseSchema,
  EditingHeartbeatBodySchema,
  EditingHeartbeatResponseSchema,
  HubIdParamsSchema,
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
    '乐观锁 / sections / block-refs 反链索引）与 Living Note refine 链（triggers→policy→' +
    'mutator|propose，YUK-358 决定6 后信号源 = mark_wrong/mastery_change/dreaming/verify，dwell 已裁）。',
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
        method: 'PATCH',
        path: '/api/artifacts/[id]/sections/[sectionId]',
        operationId: 'updateArtifactSection',
        request: {
          params: ArtifactSectionParamsSchema,
          body: EditArtifactSectionBodySchema,
        },
        responses: { 200: EditArtifactSectionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/section-edit').then((m) => m.PATCH),
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
        path: '/api/artifacts/[id]/correct',
        operationId: 'getArtifactCorrectionState',
        request: { params: ArtifactIdParamsSchema },
        responses: { 200: ArtifactCorrectionStateResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/correct').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/artifacts/[id]/correct',
        operationId: 'createArtifactCorrection',
        request: { params: ArtifactIdParamsSchema, body: CorrectArtifactBodySchema },
        responses: { 200: CreateArtifactCorrectionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/correct').then((m) => m.POST),
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
        path: '/api/hubs/[id]/dismiss-link',
        operationId: 'dismissHubLink',
        request: { params: HubIdParamsSchema, body: DismissHubLinkBodySchema },
        responses: { 200: DismissHubLinkResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/hub-dismiss-link').then((m) => m.POST),
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
        // every apply. Batch layer (ADR-0067 D2): dormant learners skip it; the
        // every-minute recovery floor below is a leak fallback, not batch work.
        name: 'hub_auto_sync_nightly',
        schedule: { cron: '45 2 * * *', tz: 'Asia/Shanghai' },
        eligibility: nightlyEligibility('deterministic'),
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
      {
        name: 'note_verify',
        queue: 'llm',
        load: () => import('./jobs/note_verify').then((m) => m.buildNoteVerifyHandler),
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
  // Notes owns the interactive-artifact authoring tools; Copilot grants them by
  // name. The backend stores the HTML opaquely (author = create v0,
  // update = full replace + version bump).
  copilotTools: {
    tools: [
      {
        name: 'author_artifact',
        load: () => import('./server/tools/author-artifact').then((m) => m.authorArtifactTool),
      },
      {
        name: 'update_artifact',
        load: () => import('./server/tools/author-artifact').then((m) => m.updateArtifactTool),
      },
    ],
  },
  ui: { pages: uiPagesFor('notes') },
});
