// The probe answer trail is keyed by session_id. Omit it and the next step cannot advance or end.

import {
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiOperationJson,
} from '@/ui/lib/api';
import type { SessionTransitionRequestOptions } from '@/ui/lib/session-transition';

// Start and next return the pinned public DTO and its recovery state.
export type PlacementStartResult = ApiOperationJsonResponse<'createPlacementSession'>;
export type PlacementQuestionRef = NonNullable<PlacementStartResult['question']>;

/** Leanings order starter questions. Pace caps the probe count. Neither feeds theta or p(L). */
export type PlacementSelfReport = Pick<
  ApiOperationRequestBody<'createPlacementSession'>,
  'leanings' | 'pace'
>;

export const startPlacement = (goalId: string, selfReport: PlacementSelfReport = {}) =>
  apiOperationJson('createPlacementSession', {
    url: '/api/placement-sessions',
    method: 'POST',
    body: {
      goalId,
      // Absent leanings or pace mean no preference and the default cap.
      ...(selfReport.leanings && selfReport.leanings.length > 0
        ? { leanings: selfReport.leanings }
        : {}),
      ...(selfReport.pace ? { pace: selfReport.pace } : {}),
    },
  });

export type PlacementNextResult = ApiOperationJsonResponse<'createPlacementQuestionSelection'>;

export const placementNext = (sessionId: string) =>
  apiOperationJson('createPlacementQuestionSelection', {
    url: `/api/placement-sessions/${encodeURIComponent(sessionId)}/question-selections`,
    method: 'POST',
    body: {},
  });

// Release records the question as not judged, never as wrong, then advances.
// The server's held_exit URLs are not fetched. They would carry the internal token.
// The issuance id is the idempotency key, so a repeated click replays the same result.
export type PlacementHeldExit = NonNullable<PlacementQuestionRef['assessment']['held_exit']>;
export const releaseHeldPlacement = (sessionId: string, issuanceId: string) =>
  apiOperationJson('createPlacementHeldRelease', {
    url: `/api/placement-sessions/${encodeURIComponent(sessionId)}/held-release`,
    method: 'POST',
    body: { issuance_id: issuanceId },
  });

export type PlacementUnresolvedItem = NonNullable<PlacementStartResult['unresolved_items']>[number];
export type PlacementNoItem = NonNullable<PlacementStartResult['no_item']>;

export const placementEnd = (
  sessionId: string,
  status: 'completed' | 'abandoned' = 'completed',
  options: SessionTransitionRequestOptions = {},
) =>
  apiOperationJson('updatePlacementSession', {
    url: `/api/placement-sessions/${encodeURIComponent(sessionId)}`,
    method: 'PATCH',
    body: { status },
    init: options.keepalive ? { keepalive: true } : undefined,
  });

export const getPlacementSession = (sessionId: string) =>
  apiOperationJson('getPlacementSession', {
    url: `/api/placement-sessions/${encodeURIComponent(sessionId)}`,
    method: 'GET',
  });

export interface SubmitProbeAnswerInput {
  sessionId: string;
  questionId: string;
  assessment: NonNullable<ApiOperationRequestBody<'createAttempt'>['assessment']>;
  responseMd: string;
  referencedKnowledgeIds: string[];
  answerImageRefs?: string[];
  latencyMs?: number | null;
}

// auto_rate keeps the placeholder rating observational. Activation owns theta and FSRS.
export const submitProbeAnswer = (input: SubmitProbeAnswerInput) =>
  apiOperationJson('createAttempt', {
    url: '/api/attempts',
    method: 'POST',
    body: {
      question_id: input.questionId,
      session_id: input.sessionId,
      assessment: input.assessment,
      rating: 'good',
      response_md: input.responseMd,
      referenced_knowledge_ids: input.referencedKnowledgeIds,
      answer_image_refs: input.answerImageRefs ?? [],
      auto_rate: true,
      latency_ms: input.latencyMs ?? null,
    },
  });

// fetch throws on a keepalive body past about 64KB. This cap stays under that.
// Onboarding does not import practice's cap.
const KEEPALIVE_MAX_BODY_BYTES = 60_000;

// An oversized keepalive body goes out as a normal best-effort fetch.
export const saveProbeResponseDraft = (
  issuanceId: string,
  body: ApiOperationRequestBody<'saveResponseDraft'>,
  options: { keepalive?: boolean } = {},
) =>
  apiOperationJson('saveResponseDraft', {
    url: `/api/issuances/${encodeURIComponent(issuanceId)}/responses`,
    method: 'POST',
    body,
    init:
      options.keepalive === true &&
      new TextEncoder().encode(JSON.stringify(body)).length <= KEEPALIVE_MAX_BODY_BYTES
        ? { keepalive: true }
        : undefined,
  });
