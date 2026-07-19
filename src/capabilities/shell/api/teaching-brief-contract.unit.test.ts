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

describe('TeachingBriefResponseSchema', () => {
  it('accepts the locked wire and quiet null', () => {
    expect(TeachingBriefResponseSchema.safeParse(findingResponse).success).toBe(true);
    expect(TeachingBriefResponseSchema.safeParse({ brief: null }).success).toBe(true);
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
