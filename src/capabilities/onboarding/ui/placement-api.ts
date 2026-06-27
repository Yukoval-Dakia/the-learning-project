// Onboarding ③ · placement probe API client (YUK-473 Slice 3).
// Wraps the inc-B placement backend (YUK-468): start → next → end, plus a probe
// answer submit that threads session_id=<probeId> into the SHARED /api/review/submit
// (which runs judge + θ̂ + FSRS — there is NO separate placement submit). The probe's
// answer trail is keyed by that session_id (placement-next.ts counts events WHERE
// session_id=<probe>), so it MUST be sent or /next can't advance/terminate.

import { apiJson } from '@/ui/lib/api';

/** start/next return only the question REF (id + info score), not the full row — the
 * caller fetches the renderable question via GET /api/questions/[id] (getQuestion). */
export interface PlacementQuestionRef {
  questionId: string;
  score: number;
  scoreKind: string;
}

export interface PlacementStartResult {
  sessionId: string;
  knowledgeIds: string[];
  question: PlacementQuestionRef | null;
  /** true when the goal subgraph has no eligible question (cold tree) → caller shows
   * the "子图还冷 · 去上传" sourcing state instead of a probe. */
  sourcingNeeded: boolean;
}

/** YUK-480 — onboarding self-report carried from the Welcome screen into the probe. Both are
 * ordering/amount-only (leanings → starter-question order, pace → probe count cap) and NEVER
 * feed θ̂/p(L). Optional — a probe started without a self-report behaves exactly as before. */
export interface PlacementSelfReport {
  leanings?: string[];
  pace?: 'light' | 'medium' | 'dense';
}

export const startPlacement = (goalId: string, selfReport: PlacementSelfReport = {}) =>
  apiJson<PlacementStartResult>('/api/placement/start', {
    method: 'POST',
    body: JSON.stringify({
      goalId,
      // Omit empty leanings / absent pace so the body stays minimal (server treats absent as
      // "no preference / default cap").
      ...(selfReport.leanings && selfReport.leanings.length > 0
        ? { leanings: selfReport.leanings }
        : {}),
      ...(selfReport.pace ? { pace: selfReport.pace } : {}),
    }),
  });

export type PlacementNextResult =
  | { done: true; reason: string; answeredCount: number }
  | {
      done: false;
      question: PlacementQuestionRef | null;
      answeredCount: number;
      sourcingNeeded: boolean;
    };

export const placementNext = (sessionId: string) =>
  apiJson<PlacementNextResult>(`/api/placement/${encodeURIComponent(sessionId)}/next`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

export const placementEnd = (sessionId: string, status: 'completed' | 'abandoned' = 'completed') =>
  apiJson(`/api/placement/${encodeURIComponent(sessionId)}/end`, {
    method: 'POST',
    body: JSON.stringify({ status }),
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
  apiJson('/api/review/submit', {
    method: 'POST',
    body: JSON.stringify({
      question_id: input.questionId,
      session_id: input.sessionId,
      rating: 'good',
      response_md: input.responseMd,
      referenced_knowledge_ids: input.referencedKnowledgeIds,
      answer_image_refs: input.answerImageRefs ?? [],
      auto_rate: true,
      latency_ms: input.latencyMs ?? null,
    }),
  });
