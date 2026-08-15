import { MASTERY_PROGRESS_ACTION } from '@/core/schema/event';
import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
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
  NotePageResponseSchema,
  RecentArtifactAiChangesResponseSchema,
  UndoArtifactAiChangeResponseSchema,
} from './api/contracts';

// M3-T1 (YUK-317)：notes 包骨架。routes 在 T4（API 上 Hono）逐条填充——
// 9 条：notes/[id] GET + artifacts/[id]/{body-blocks,sections/[sectionId],
// backlinks,correct,ai-changes,ai-changes/[eventId]/undo} + artifacts/search
// + hubs/[id]/dismiss-link。M4-T5 (YUK-319) 增 1 条：artifacts/ai-changes/recent。
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
    // M3-T4 (YUK-317)：9 条路由全带 load 懒加载 thunk（M1/M2 配方）。
    // M5-T5a (YUK-321)：/api/editing-session/* 收编。
    // YUK-358 决定3：/api/embedded-check/* 孤儿链真删（曾随 M5 等价平移留 D6 墓碑）。
    routes: [
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
        // M4-T5 (YUK-319)：近 24h 全局 AI 改动条（旧 app/api/today/ai-changes
        // GET 等价平移；批量 undo POST 不平移，撤销走下方 per-event undo 链）。
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
      // M5-T5a (YUK-321) — editing-session 收编。YUK-358 决定6：heartbeat 的 dwell
      // note_refine 触发已裁撤，本路由现为纯 presence 写（editing_presence DEFER 仲裁）。
      // YUK-358 决定3：/api/embedded-check/attempt 路由随内嵌判分自测孤儿链真删
      //（graded inline self-test 被 D6 + B1 裁撤，SPA 零消费）。
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
        // YUK-384：nightly hub-sync COVERAGE REPAIR sweep（BJT 02:45）——不再直接 apply，
        // 只 dirty/cancel 游标，靠 reconciler 收敛（never direct apply）。
        name: 'hub_auto_sync_nightly',
        schedule: { cron: '45 2 * * *', tz: 'Asia/Shanghai' },
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
        // YUK-384：immediate mutation-wake queue（链式/按需，无 cron）。生产者 = 三个
        // 已接线的拓扑 handler（POST /api/knowledge/edges、/api/proposals/[id]/decisions、
        // /api/teaching-sessions/[id]/accept-chip）经 wakeHubSyncAfterCommit 提交后best-effort
        // 发一个合并 wake；消费者 = 本 handler 跑 runHubSyncCycle({reason:'mutation_wake'})，
        // 即时收敛（不再只靠每分钟 recovery 兜底）。
        name: 'hub_sync_mutation_wake',
        queue: 'llm',
        load: () =>
          import('./jobs/hub_auto_sync_nightly').then((m) => m.buildHubSyncMutationWakeJobHandler),
      },
      {
        // Wave 6 / T-88 P4-A (YUK-127)：Living Note refine。链式/按需（触发器投递），无 cron。
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
  // M4-T4 (YUK-319)：proposal kind 归属声明。note_update 的 accept 持久化委托
  // ./server/note-refine-apply（persistNoteRefineApply，M3 起）；壳层
  // acceptNoteUpdateProposal 只做校验 + rate event 编排（plan 裁决 T4 只补声明不迁体）。
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
  // YUK-880 (F3.9b) — Notes owns the interactive-artifact authoring DomainTools
  // (moved from the central src/server/ai/tools/author-artifact.ts). Copilot
  // keeps the surface grant via the allowlist NAMES in allowlists.ts — only the
  // implementation ownership moved (author = create v0, update = full-html
  // replace + version bump, ADR-0033 D6).
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
