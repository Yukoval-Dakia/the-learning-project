// YUK-706 — strict public TeachingBrief wire lock. Future seams must revise both
// the server discriminated union and this schema before crossing the route.

import { describe, expect, it } from 'vitest';
import { TeachingBriefInteractionBodySchema, TeachingBriefResponseSchema } from './contracts';

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

// YUK-708/709 (P0F/4-5) — outcome states carry an executable action; the strict schema was
// upgraded in lockstep with the discriminated union (contract §2.1). A confirmed outcome's
// action is KC-scoped practice; a retired one's is the acknowledge (dismiss).
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
    prepared_action: {
      kind: 'practice_scoped',
      knowledge_id: 'kn_contract',
      probe_result_event_id: 'evt_result',
    },
    current_outcome: {
      status: 'confirmed',
      summary_md: '这条判断得到这次探针的支持。',
      probe_question_id: 'q_probe',
      probe_result_event_id: 'evt_result',
    },
  },
} as const;

const retiredResponse = {
  brief: {
    ...outcomeResponse.brief,
    state: 'outcome_retired',
    prepared_action: { kind: 'acknowledge_outcome', probe_result_event_id: 'evt_result' },
    current_outcome: {
      status: 'retired',
      summary_md: '这条判断被这次探针排除。',
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

  it('accepts a confirmed outcome carrying the practice_scoped action', () => {
    expect(TeachingBriefResponseSchema.safeParse(outcomeResponse).success).toBe(true);
  });

  it('accepts a retired outcome carrying the acknowledge_outcome action', () => {
    expect(TeachingBriefResponseSchema.safeParse(retiredResponse).success).toBe(true);
  });

  it('rejects the retired P0F/2 outcome shape (prepared_action {kind:none})', () => {
    const stale = {
      brief: { ...outcomeResponse.brief, prepared_action: { kind: 'none' } },
    };
    expect(TeachingBriefResponseSchema.safeParse(stale).success).toBe(false);
  });

  it('rejects a confirmed outcome still carrying the retired acknowledge_outcome action', () => {
    // A confirmed outcome MUST offer the practice action (contract §9); the acknowledge-only
    // shape is now retired-exclusive, so the confirmed branch rejects it.
    const stale = {
      brief: {
        ...outcomeResponse.brief,
        prepared_action: { kind: 'acknowledge_outcome', probe_result_event_id: 'evt_result' },
      },
    };
    expect(TeachingBriefResponseSchema.safeParse(stale).success).toBe(false);
  });

  it('rejects a confirmed outcome whose practice action targets a different result than current_outcome', () => {
    const drifted = {
      brief: {
        ...outcomeResponse.brief,
        // probe_result_event_id drifts from current_outcome — a projection regression the
        // cross-field refine must catch (round-7, extended to practice_scoped).
        prepared_action: {
          kind: 'practice_scoped',
          knowledge_id: 'kn_contract',
          probe_result_event_id: 'evt_other',
        },
      },
    };
    expect(TeachingBriefResponseSchema.safeParse(drifted).success).toBe(false);
  });

  it('rejects a confirmed outcome whose practice KC drifts from the finding KC', () => {
    const drifted = {
      brief: {
        ...outcomeResponse.brief,
        // knowledge_id must equal finding.knowledge_id (YUK-709) so the CTA can only open
        // practice for the point the brief is about.
        prepared_action: {
          kind: 'practice_scoped',
          knowledge_id: 'kn_other',
          probe_result_event_id: 'evt_result',
        },
      },
    };
    expect(TeachingBriefResponseSchema.safeParse(drifted).success).toBe(false);
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

// YUK-710 (P0F/6) — the interaction ledger body. The result_event_id join key is scoped_practice-
// only; the schema (not just a comment) enforces that.
describe('TeachingBriefInteractionBodySchema', () => {
  it('accepts a brief_seen', () => {
    expect(
      TeachingBriefInteractionBodySchema.safeParse({
        type: 'brief_seen',
        brief_id: 'p_contract',
        brief_state: 'finding',
      }).success,
    ).toBe(true);
  });

  it('accepts scoped_practice WITH a result_event_id, and accept/answer WITHOUT one', () => {
    expect(
      TeachingBriefInteractionBodySchema.safeParse({
        type: 'primary_action_started',
        brief_id: 'p_contract',
        action_kind: 'scoped_practice',
        result_event_id: 'evt_result',
      }).success,
    ).toBe(true);
    expect(
      TeachingBriefInteractionBodySchema.safeParse({
        type: 'primary_action_started',
        brief_id: 'p_contract',
        action_kind: 'accept_probe',
      }).success,
    ).toBe(true);
  });

  it('rejects scoped_practice MISSING its required result_event_id', () => {
    // Required, not optional: the report's confirmed→scoped-practice numerator joins on it, and the
    // deterministic event id means a first row written without it could never be back-filled.
    expect(
      TeachingBriefInteractionBodySchema.safeParse({
        type: 'primary_action_started',
        brief_id: 'p_contract',
        action_kind: 'scoped_practice',
      }).success,
    ).toBe(false);
  });

  it('rejects a result_event_id on a non-scoped_practice action', () => {
    for (const action_kind of ['accept_probe', 'answer_probe'] as const) {
      expect(
        TeachingBriefInteractionBodySchema.safeParse({
          type: 'primary_action_started',
          brief_id: 'p_contract',
          action_kind,
          result_event_id: 'evt_result',
        }).success,
      ).toBe(false);
    }
  });

  it('rejects an unknown action_kind, empty brief_id, and extra keys', () => {
    expect(
      TeachingBriefInteractionBodySchema.safeParse({
        type: 'primary_action_started',
        brief_id: 'p_contract',
        action_kind: 'bogus',
      }).success,
    ).toBe(false);
    expect(
      TeachingBriefInteractionBodySchema.safeParse({
        type: 'brief_seen',
        brief_id: '',
        brief_state: 'finding',
      }).success,
    ).toBe(false);
    expect(
      TeachingBriefInteractionBodySchema.safeParse({
        type: 'brief_seen',
        brief_id: 'p_contract',
        brief_state: 'finding',
        answer_md: 'leak',
      }).success,
    ).toBe(false);
  });
});
