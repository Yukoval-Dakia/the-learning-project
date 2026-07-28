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

import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

export type TeachingBriefResponse = ApiOperationJsonResponse<'getTeachingBrief'>;
export type TeachingBrief = NonNullable<TeachingBriefResponse['brief']>;
export type FindingTeachingBrief = Extract<TeachingBrief, { state: 'finding' }>;
export type ProbeReadyTeachingBrief = Extract<TeachingBrief, { state: 'probe_ready' }>;
export type OutcomeEvidenceForTeachingBrief = Extract<
  TeachingBrief,
  { state: 'outcome_evidence_for' }
>;
export type OutcomeConfirmedTeachingBrief = Extract<TeachingBrief, { state: 'outcome_confirmed' }>;
export type OutcomeRetiredTeachingBrief = Extract<TeachingBrief, { state: 'outcome_retired' }>;
export type TeachingBriefEvidenceRef = TeachingBrief['basis']['evidence_trace'][number];
export type TeachingBriefFindingSection = TeachingBrief['finding'];
export type TeachingBriefBasisSection = TeachingBrief['basis'];
export type OutcomeAcknowledgeAction = OutcomeRetiredTeachingBrief['prepared_action'];
export type OutcomePracticeAction = OutcomeConfirmedTeachingBrief['prepared_action'];

export const getTeachingBrief = () =>
  apiOperationJson('getTeachingBrief', {
    url: '/api/prep-desk/brief',
    method: 'GET',
  });

export type TeachingBriefAckResult = ApiOperationJsonResponse<'acknowledgeTeachingBrief'>;

/**
 * Acknowledge a delivered outcome. Append-only + idempotent server-side: a repeated
 * click (or a retry after a transient failure) writes no second anchor. On success the
 * caller invalidates ['teaching-brief'] so the acked result drops and the next candidate
 * (or the quiet null) is projected.
 */
export const ackTeachingBriefOutcome = (probeResultEventId: string) =>
  apiOperationJson('acknowledgeTeachingBrief', {
    url: '/api/prep-desk/brief/ack',
    method: 'POST',
    body: { probe_result_event_id: probeResultEventId },
  });
