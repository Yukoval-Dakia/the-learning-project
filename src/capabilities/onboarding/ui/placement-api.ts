// Onboarding ③ · placement probe API client (YUK-473 Slice 3).
// Wraps the inc-B placement backend (YUK-468): start → next → end, plus a probe
// answer submit that threads session_id=<probeId> into the shared /api/attempts resource
// (which runs native activation + θ̂ + FSRS). The probe's
// answer trail is keyed by that session_id (placement-next.ts counts events WHERE
// session_id=<probe>), so it MUST be sent or /next can't advance/terminate.

import {
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiOperationJson,
} from '@/ui/lib/api';
import type { SessionTransitionRequestOptions } from '@/ui/lib/session-transition';

// Start/next return the pinned public DTO and its recovery state.
export type PlacementStartResult = ApiOperationJsonResponse<'createPlacementSession'>;
export type PlacementQuestionRef = NonNullable<PlacementStartResult['question']>;

/** YUK-480 — onboarding self-report carried from the Welcome screen into the probe. Both are
 * ordering/amount-only (leanings → starter-question order, pace → probe count cap) and NEVER
 * feed θ̂/p(L). Optional — a probe started without a self-report behaves exactly as before. */
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
      // Omit empty leanings / absent pace so the body stays minimal (server treats absent as
      // "no preference / default cap").
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

// auto_rate keeps the placeholder rating observational. Activation owns θ and FSRS.
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

// Probe answer draft: the shared issuance responses resource, same request as practice's saver.
export const saveProbeResponseDraft = (
  issuanceId: string,
  body: ApiOperationRequestBody<'saveResponseDraft'>,
  options: { keepalive?: boolean } = {},
) =>
  apiOperationJson('saveResponseDraft', {
    url: `/api/issuances/${encodeURIComponent(issuanceId)}/responses`,
    method: 'POST',
    body,
    init: options.keepalive ? { keepalive: true } : undefined,
  });
