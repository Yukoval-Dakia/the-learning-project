// 定位 owner 的 manifest 片段，由根 `manifest.ts` 组合。
import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import type { CapabilityManifest } from '@/kernel/manifest';
import {
  CreatePlacementHeldReleaseBodySchema,
  CreatePlacementQuestionSelectionBodySchema,
  CreatePlacementSessionBodySchema,
  PlacementHeldReleaseResponseSchema,
  PlacementProfileQuerySchema,
  PlacementProfileResponseSchema,
  PlacementQuestionSelectionResponseSchema,
  PlacementSessionCreatedSchema,
  PlacementSessionParamsSchema,
  PlacementSessionResponseSchema,
  PlacementSessionTransitionResponseSchema,
  UpdatePlacementSessionBodySchema,
} from './api/placement-contracts';

export const placementManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {
  events: {
    actions: [
      'experimental:assessment_placement_issued',
      // YUK-1405 L1 — learner-released held issuance (recorded unresolved).
      'experimental:assessment_placement_released',
      // YUK-1405 L2 — once-per-session marker: first "no servable item" outcome
      // with the real elapsed session→alternative time.
      'experimental:assessment_placement_no_item',
    ],
  },
  api: {
    routes: [
      // YUK-468 cold-start inc-B — placement probe 会话 API (dark-ship, gated on
      // PLACEMENT_PROBE_ENABLED). start → first question; [id]/next → terminate-check + next
      // question; [id]/end → complete/abandon. Answers now go through /api/attempts with the
      // probe's session_id (shared judge + θ̂ path, no separate placement submit).
      {
        method: 'POST',
        path: '/api/placement-sessions',
        operationId: 'createPlacementSession',
        request: { body: CreatePlacementSessionBodySchema },
        responses: { 201: PlacementSessionCreatedSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/placement-start').then((m) => m.createPlacementSessionResource),
      },
      {
        method: 'POST',
        path: '/api/placement-sessions/[id]/question-selections',
        operationId: 'createPlacementQuestionSelection',
        request: {
          params: PlacementSessionParamsSchema,
          body: CreatePlacementQuestionSelectionBodySchema,
        },
        responses: { 200: PlacementQuestionSelectionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/placement-next').then((m) => m.createPlacementQuestionSelection),
      },
      // YUK-1405 L1 — held item 的「继续」出口：记录未决（不算答错）并推进。
      // 「结束」出口走 PATCH /api/placement-sessions/[id]（unresolved_items）。
      {
        method: 'POST',
        path: '/api/placement-sessions/[id]/held-release',
        operationId: 'createPlacementHeldRelease',
        request: {
          params: PlacementSessionParamsSchema,
          body: CreatePlacementHeldReleaseBodySchema,
        },
        responses: { 200: PlacementHeldReleaseResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/placement-held-release').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/placement-sessions/[id]',
        operationId: 'getPlacementSession',
        request: { params: PlacementSessionParamsSchema },
        responses: { 200: PlacementSessionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/placement-session-detail').then((m) => m.GET),
      },
      {
        method: 'PATCH',
        path: '/api/placement-sessions/[id]',
        operationId: 'updatePlacementSession',
        request: {
          params: PlacementSessionParamsSchema,
          body: UpdatePlacementSessionBodySchema,
        },
        responses: { 200: PlacementSessionTransitionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/placement-session-detail').then((m) => m.PATCH),
      },
      // YUK-473 Slice 4 — placement-done 起始档案读：GET ?goal=<id> → per-KC mastery over
      // the goal scope (getMasteryProjection SoT; untested in-scope KCs → tested:false).
      // Read-only. Literal `/profile` segment — distinct from `/placement/[id]/*`.
      {
        method: 'GET',
        path: '/api/placement/profile',
        operationId: 'getPlacementProfile',
        request: { query: PlacementProfileQuerySchema },
        responses: { 200: PlacementProfileResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/placement-profile').then((m) => m.GET),
      },
    ],
  },
};
