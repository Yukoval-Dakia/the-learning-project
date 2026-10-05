import { describe, expect, it } from 'vitest';
import { projectNativeReviewOccurrences } from './assessment-review-occurrences';

const group = new Map([['group', { questionIds: ['q1', 'q2'], outcome: 'failure' as const }]]);
function receipt(id: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    payload: {
      evaluation_group_id: 'group',
      effect: 'applied',
      occurrence_at: '2026-10-05T00:01:00Z',
      effects: { fsrs_applied: ['knowledge:k1', 'knowledge:k2'] },
      replay_inputs: {
        kind: 'plan',
        groupId: 'group',
        occurrenceAt: '2026-10-05T00:01:00Z',
        rating: 'good',
        ratingSource: 'user',
      },
      ...extras,
    },
  };
}

describe('native review occurrence projection', () => {
  it('counts a joint occurrence once and keeps explicit good independent from incorrect', () => {
    expect(projectNativeReviewOccurrences([receipt('s1')], group)).toEqual([
      expect.objectContaining({
        id: 'assessment:group',
        questionIds: ['q1', 'q2'],
        rating: 'good',
        outcome: 'failure',
        fsrsSubjects: ['knowledge:k1', 'knowledge:k2'],
      }),
    ]);
  });
  it('deduplicates replay and retains the original occurrence date regardless of receipt order', () => {
    const rows = [
      receipt('s1'),
      receipt('s2', { replay_of: 's1', reverted_settlement_event_ids: ['s1'] }),
    ];
    const expected = projectNativeReviewOccurrences(rows, group);
    expect(expected).toHaveLength(1);
    expect(expected[0]).toMatchObject({
      settlementId: 's2',
      occurredAt: new Date('2026-10-05T00:01:00Z'),
    });
    expect(projectNativeReviewOccurrences([...rows].reverse(), group)).toEqual(expected);
  });
  it('preserves a user scheduling segment when an ineligible replacement does not touch FSRS', () => {
    const replacement = receipt('s2', {
      effect: 'ineligible',
      supersedes_settlement_event_id: 's1',
      reverted_settlement_event_ids: ['s1'],
      effects: { fsrs_applied: [] },
      replay_inputs: null,
    });
    expect(projectNativeReviewOccurrences([receipt('s1'), replacement], group)).toHaveLength(1);
  });
  it('excludes capture-only effects, withdrawn occurrences and hidden groups', () => {
    expect(
      projectNativeReviewOccurrences([receipt('s1', { effects: { fsrs_applied: [] } })], group),
    ).toEqual([]);
    expect(
      projectNativeReviewOccurrences(
        [
          receipt('s1'),
          receipt('withdraw', {
            effect: 'withdrawn',
            replay_inputs: null,
            effects: { fsrs_applied: [] },
          }),
        ],
        group,
      ),
    ).toEqual([]);
    expect(projectNativeReviewOccurrences([receipt('s1')], new Map())).toEqual([]);
  });
  it('does not manufacture effects for first failed_pending, but retains prior scheduling after a failed replacement', () => {
    const failed = receipt('failed', {
      effect: 'failed_pending',
      effects: { fsrs_applied: [] },
      replay_inputs: null,
    });
    expect(projectNativeReviewOccurrences([failed], group)).toEqual([]);
    expect(projectNativeReviewOccurrences([receipt('s1'), failed], group)).toHaveLength(1);
  });
});
