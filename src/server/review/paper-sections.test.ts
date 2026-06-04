// U5 (YUK-203, §4.8) — readPaperSections shim + resolveSlotAssignment unit
// tests (pure, no DB → unit partition).

import { describe, expect, it } from 'vitest';
import { readPaperSections, resolveSlotAssignment } from './paper-sections';

const section = {
  knowledge_focus: ['k1'],
  feedback_policy: 'judge_now_show_later',
  adaptation_policy: 'none',
  assignments: [
    {
      question_id: 'q1',
      primary_knowledge_id: 'k1',
      secondary_knowledge_ids: ['k2'],
      selection_reason: 'x',
      review_profile_snapshot: {},
    },
    {
      question_id: 'q2',
      part_ref: 'q2#a',
      primary_knowledge_id: 'k3',
      secondary_knowledge_ids: [],
      selection_reason: 'y',
      review_profile_snapshot: {},
    },
  ],
};

describe('readPaperSections (U4→U5 forward-compat shim)', () => {
  it('returns top-level U5 sections when present', () => {
    expect(readPaperSections({ question_ids: [], sections: [section] as never })).toHaveLength(1);
  });

  it('falls back to U4 session_meta.sections', () => {
    const out = readPaperSections({
      question_ids: [],
      session_meta: { sections: [section] },
    } as never);
    expect(out).toHaveLength(1);
    expect(out[0].assignments).toHaveLength(2);
  });

  it('prefers top-level over session_meta when both exist', () => {
    const out = readPaperSections({
      question_ids: [],
      sections: [section] as never,
      session_meta: { sections: [] },
    } as never);
    expect(out).toHaveLength(1);
  });

  it('returns [] for a flat quiz with no sections anywhere', () => {
    expect(readPaperSections({ question_ids: ['q1'] })).toEqual([]);
    expect(readPaperSections(null)).toEqual([]);
    expect(readPaperSections(undefined)).toEqual([]);
  });
});

describe('resolveSlotAssignment', () => {
  const toolState = { question_ids: ['q1', 'q2'], sections: [section] as never };

  it('resolves an atomic slot (part_ref null) with its primary knowledge + policy', () => {
    const slot = resolveSlotAssignment(toolState, 'q1', null);
    expect(slot).toEqual({
      questionId: 'q1',
      partRef: null,
      primaryKnowledgeId: 'k1',
      secondaryKnowledgeIds: ['k2'],
      feedbackPolicy: 'judge_now_show_later',
    });
  });

  it('resolves a part slot by part_ref', () => {
    const slot = resolveSlotAssignment(toolState, 'q2', 'q2#a');
    expect(slot?.primaryKnowledgeId).toBe('k3');
    expect(slot?.partRef).toBe('q2#a');
  });

  it('returns null when the slot is not in the plan', () => {
    expect(resolveSlotAssignment(toolState, 'q1', 'wrong#part')).toBeNull();
    expect(resolveSlotAssignment(toolState, 'q9', null)).toBeNull();
  });
});
