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

// YUK-1405 — a held question's way forward: release it (recorded as not judged, never as
// wrong) and advance. The URL is built here from the session id, like placementEnd: the
// server's held_exit only signals that the exit is offered, and its URLs are never fetched
// (they would carry the internal token wherever they point). The issuance id is the server's
// idempotency key, so a repeated click replays the same result.
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

// keepalive bodies share a ~64KB page budget and fetch throws on one over it; same cap as
// practice's draft saver (kept local: onboarding takes no value import from practice).
const KEEPALIVE_MAX_BODY_BYTES = 60_000;

// Probe answer draft: the shared issuance responses resource, same request as practice's saver.
// YUK-1487 — an oversized keepalive body goes out as a normal (best-effort) fetch instead.
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
