// Onboarding ③ · placement probe API client (YUK-473 Slice 3).
// Wraps the inc-B placement backend (YUK-468): start → next → end, plus a probe
// answer submit that threads session_id=<probeId> into the shared /api/attempts resource
// (which runs judge + θ̂ + FSRS — there is NO separate placement submit). The probe's
// answer trail is keyed by that session_id (placement-next.ts counts events WHERE
// session_id=<probe>), so it MUST be sent or /next can't advance/terminate.

import {
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiOperationJson,
} from '@/ui/lib/api';
import type { SessionTransitionRequestOptions } from '@/ui/lib/session-transition';

/** start/next return only the question REF (id + info score), not the full row — the
 * caller fetches the renderable question via GET /api/questions/[id] (getQuestion). */
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

export interface SubmitProbeAnswerInput {
  sessionId: string;
  questionId: string;
  responseMd: string;
  referencedKnowledgeIds: string[];
  answerImageRefs?: string[];
  latencyMs?: number | null;
}

// Submit one probe answer through the shared review/submit. `auto_rate:true` → the
// judge's objective outcome sets the rating + drives θ̂ (the probe estimates ability;
// the user never self-rates). The verdict is deliberately NOT surfaced mid-probe
// (design: 答完统一反馈, 先别急着看对错) — we ignore the response body except for error
// handling. `rating:'good'` is a placeholder the server overrides under auto_rate.
export const submitProbeAnswer = (input: SubmitProbeAnswerInput) =>
  apiOperationJson('createAttempt', {
    url: '/api/attempts',
    method: 'POST',
    body: {
      question_id: input.questionId,
      session_id: input.sessionId,
      rating: 'good',
      response_md: input.responseMd,
      referenced_knowledge_ids: input.referencedKnowledgeIds,
      answer_image_refs: input.answerImageRefs ?? [],
      auto_rate: true,
      latency_ms: input.latencyMs ?? null,
    },
  });
