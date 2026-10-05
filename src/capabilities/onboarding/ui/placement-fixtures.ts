import type { PlacementQuestionRef } from './placement-api';

export function placementQuestionFixture(): PlacementQuestionRef {
  return {
    questionId: 'q1',
    score: 0.25,
    scoreKind: 'klp',
    assessment: {
      issuance_id: 'iss_placement_1',
      evaluation_group_id: 'eg_placement_1',
      submission_id: 'sub_placement_1',
      idempotency_key: 'key_placement_1',
      phase: 'answering',
      pending_run: null,
      state: {
        issuance: {
          issuance_id: 'iss_placement_1',
          issued_at: '2026-10-05T00:00:00.000Z',
          binding: {
            revision_id: 'rev1',
            part_ids: ['q1'],
            material_bindings: [],
            option_order: [],
          },
          claim: { policy: 'unbounded', status: 'unclaimed', claimed_by_ref: null },
        },
        practice_dto: {
          issuance_id: 'iss_placement_1',
          revision_id: 'rev1',
          issued_at: '2026-10-05T00:00:00.000Z',
          faces: [{ part_id: 'q1', prompt_md: '用一句话解释导数。', material_ids: [] }],
          materials: [],
          response_spec: {
            slots: [{ part_id: 'q1', slot_id: 'native_text', kind: 'text', math_preview: false }],
          },
        },
        admission_generation_observed: 1,
        draft: null,
        submissions: [],
      },
    },
  };
}
export function placementStartFixture(question = placementQuestionFixture()) {
  return {
    sessionId: 'placement_1',
    knowledgeIds: ['kn_1'],
    answeredCount: 0,
    question,
    sourcingNeeded: false,
  };
}
