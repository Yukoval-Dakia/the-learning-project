// YUK-706 — strict public TeachingBrief wire lock. Future seams must revise both
// the server discriminated union and this schema before crossing the route.

import { describe, expect, it } from 'vitest';
import { TeachingBriefResponseSchema } from './contracts';

const findingResponse = {
  brief: {
    brief_id: 'p_contract',
    state: 'finding',
    updated_at: '2026-07-19T12:00:00.000Z',
    expires_at: '2026-07-26T12:00:00.000Z',
    finding: {
      claim_md: '待检验判断',
      knowledge_id: 'kn_contract',
      cause_category: 'concept_misunderstanding',
    },
    basis: {
      summary_md: '可追溯依据',
      evidence_trace: [{ role: 'induction', kind: 'event', id: 'evt_evidence' }],
    },
    prepared_action: {
      kind: 'review_finding',
      proposal_id: 'p_contract',
      probe_preview_md: '判别题',
    },
    current_outcome: {
      status: 'awaiting_decision',
      summary_md: '这仍是一条待检验的判断。',
    },
  },
} as const;

// YUK-708 (P0F/4) — outcome states carry the executable ack action; the strict schema
// was upgraded in lockstep with the discriminated union (contract §2.1).
const outcomeResponse = {
  brief: {
    brief_id: 'p_contract',
    state: 'outcome_confirmed',
    updated_at: '2026-07-19T12:00:00.000Z',
    expires_at: '2026-07-26T12:00:00.000Z',
    finding: {
      claim_md: '待检验判断',
      knowledge_id: 'kn_contract',
      cause_category: 'concept_misunderstanding',
    },
    basis: {
      summary_md: '可追溯依据',
      evidence_trace: [
        { role: 'induction', kind: 'event', id: 'evt_evidence' },
        { role: 'probe', kind: 'question', id: 'q_probe' },
        { role: 'outcome', kind: 'event', id: 'evt_result' },
      ],
    },
    prepared_action: { kind: 'acknowledge_outcome', probe_result_event_id: 'evt_result' },
    current_outcome: {
      status: 'confirmed',
      summary_md: '这条判断得到这次探针的支持。',
      probe_question_id: 'q_probe',
      probe_result_event_id: 'evt_result',
    },
  },
} as const;

describe('TeachingBriefResponseSchema', () => {
  it('accepts the locked wire and quiet null', () => {
    expect(TeachingBriefResponseSchema.safeParse(findingResponse).success).toBe(true);
    expect(TeachingBriefResponseSchema.safeParse({ brief: null }).success).toBe(true);
  });

  it('accepts an outcome brief carrying the acknowledge_outcome action', () => {
    expect(TeachingBriefResponseSchema.safeParse(outcomeResponse).success).toBe(true);
  });

  it('rejects the retired P0F/2 outcome shape (prepared_action {kind:none})', () => {
    const stale = {
      brief: { ...outcomeResponse.brief, prepared_action: { kind: 'none' } },
    };
    expect(TeachingBriefResponseSchema.safeParse(stale).success).toBe(false);
  });

  it.each([
    ['top-level future section', { ...findingResponse.brief, plan_impact: null }],
    ['future action', { ...findingResponse.brief, prepared_action: { kind: 'continue_plan' } }],
    [
      'role-kind mismatch',
      {
        ...findingResponse.brief,
        basis: {
          ...findingResponse.brief.basis,
          evidence_trace: [{ role: 'probe', kind: 'event', id: 'evt_wrong' }],
        },
      },
    ],
    [
      'missing induction evidence',
      {
        ...findingResponse.brief,
        basis: {
          ...findingResponse.brief.basis,
          evidence_trace: [{ role: 'probe', kind: 'question', id: 'q_probe' }],
        },
      },
    ],
    [
      'invalid cause category',
      {
        ...findingResponse.brief,
        finding: { ...findingResponse.brief.finding, cause_category: 'Not A Cause' },
      },
    ],
  ])('rejects %s', (_label, brief) => {
    expect(TeachingBriefResponseSchema.safeParse({ brief }).success).toBe(false);
  });
});
