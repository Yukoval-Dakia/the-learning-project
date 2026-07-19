// YUK-707 (P0F/3 教研简报 on /today) — client wire types + caller for the single
// "为你而备" teaching brief. Hand-written mirror of the server discriminated union in
// src/capabilities/shell/server/teaching-brief.ts (same idiom as prep-desk-api.ts /
// probe-answer-api.ts), so browser code never imports a server module.
//
// Anti-guilt wire lock (contract §8.1): calibration/confidence/predicted_p/
// baseline_p/recurrence_count and any pending/backlog/unread/overnight counts are
// DELIBERATELY ABSENT from this mirror — they are not on the wire and must never be.
// The only ids present (brief_id / knowledge_id / proposal_id / probe_question_id /
// evidence ids) are transport metadata; the UI never renders them (contract §8.2).

import { apiJson } from '@/ui/lib/api';

/** One provenance ref. `role` discriminates; `kind`/`id` are opaque source labels. */
export type TeachingBriefEvidenceRef =
  | {
      role: 'induction';
      kind: 'event' | 'question' | 'knowledge' | 'artifact' | 'record';
      id: string;
    }
  | { role: 'probe'; kind: 'question'; id: string }
  | { role: 'outcome'; kind: 'event'; id: string };

export interface TeachingBriefFindingSection {
  claim_md: string;
  knowledge_id: string;
  /** canonical CauseCategory on the server; the client never branches on it. */
  cause_category: string;
}

export interface TeachingBriefBasisSection {
  summary_md: string;
  evidence_trace: TeachingBriefEvidenceRef[];
}

export interface TeachingBriefBase {
  brief_id: string;
  state: 'finding' | 'probe_ready' | 'outcome_confirmed' | 'outcome_retired';
  updated_at: string;
  expires_at: string | null;
  finding: TeachingBriefFindingSection;
  basis: TeachingBriefBasisSection;
}

export interface FindingTeachingBrief extends TeachingBriefBase {
  state: 'finding';
  expires_at: string;
  prepared_action: {
    kind: 'review_finding';
    proposal_id: string;
    probe_preview_md: string;
  };
  current_outcome: {
    status: 'awaiting_decision';
    summary_md: string;
  };
}

export interface ProbeReadyTeachingBrief extends TeachingBriefBase {
  state: 'probe_ready';
  expires_at: null;
  prepared_action: {
    kind: 'answer_probe';
    probe_question_id: string;
    prompt_md: string;
  };
  current_outcome: {
    status: 'awaiting_answer';
    summary_md: string;
  };
}

/** YUK-708 (P0F/4) — the outcome states' executable step: acknowledge (dismiss). */
export interface OutcomeAcknowledgeAction {
  kind: 'acknowledge_outcome';
  probe_result_event_id: string;
}

export interface OutcomeConfirmedTeachingBrief extends TeachingBriefBase {
  state: 'outcome_confirmed';
  expires_at: string;
  prepared_action: OutcomeAcknowledgeAction;
  current_outcome: {
    status: 'confirmed';
    summary_md: string;
    probe_question_id: string;
    probe_result_event_id: string;
  };
}

export interface OutcomeRetiredTeachingBrief extends TeachingBriefBase {
  state: 'outcome_retired';
  expires_at: string;
  prepared_action: OutcomeAcknowledgeAction;
  current_outcome: {
    status: 'retired';
    summary_md: string;
    probe_question_id: string;
    probe_result_event_id: string;
  };
}

export type TeachingBrief =
  | FindingTeachingBrief
  | ProbeReadyTeachingBrief
  | OutcomeConfirmedTeachingBrief
  | OutcomeRetiredTeachingBrief;

export interface TeachingBriefResponse {
  brief: TeachingBrief | null;
}

export const getTeachingBrief = () => apiJson<TeachingBriefResponse>('/api/prep-desk/brief');

/** Result of acknowledging (dismissing) a delivered outcome (YUK-708). */
export interface TeachingBriefAckResult {
  brief_acknowledgement_event_id: string;
  probe_result_event_id: string;
  brief_id: string;
  /** true when a prior ack already existed — the retry is safe, one anchor only. */
  idempotent: boolean;
}

/**
 * Acknowledge a delivered outcome. Append-only + idempotent server-side: a repeated
 * click (or a retry after a transient failure) writes no second anchor. On success the
 * caller invalidates ['teaching-brief'] so the acked result drops and the next candidate
 * (or the quiet null) is projected.
 */
export const ackTeachingBriefOutcome = (probeResultEventId: string) =>
  apiJson<TeachingBriefAckResult>('/api/prep-desk/brief/ack', {
    method: 'POST',
    body: JSON.stringify({ probe_result_event_id: probeResultEventId }),
  });
