// YUK-203 U4 / D5 — ReviewSessionProposal brief extension back-compat.

import { describe, expect, it } from 'vitest';
import { ReviewSessionProposal, TodayPlan } from './coach';

describe('ReviewSessionProposal brief extension (YUK-203 U4)', () => {
  it('parses the OLD flat shape — new brief fields default', () => {
    const parsed = ReviewSessionProposal.parse({ count: 12, estimated_minutes: 20 });
    expect(parsed.count).toBe(12);
    expect(parsed.estimated_minutes).toBe(20);
    // back-compat: the brief fields default so plans emitted before U4 parse.
    expect(parsed.knowledge_focus).toEqual([]);
    expect(parsed.subject_mix).toEqual([]);
    expect(parsed.intent_tags).toEqual([]);
    expect(parsed.time_box_minutes).toBeUndefined();
  });

  it('parses the FULL brief shape', () => {
    const parsed = ReviewSessionProposal.parse({
      count: 8,
      estimated_minutes: 15,
      knowledge_focus: ['k_zhi', 'k_qi'],
      subject_mix: [{ subject_id: 'wenyan', weight: 1 }],
      time_box_minutes: 25,
      intent_tags: ['weak_recovery'],
    });
    expect(parsed.knowledge_focus).toEqual(['k_zhi', 'k_qi']);
    expect(parsed.subject_mix).toEqual([{ subject_id: 'wenyan', weight: 1 }]);
    expect(parsed.time_box_minutes).toBe(25);
    expect(parsed.intent_tags).toEqual(['weak_recovery']);
  });

  it('keeps count + estimated_minutes required', () => {
    expect(ReviewSessionProposal.safeParse({ estimated_minutes: 20 }).success).toBe(false);
    expect(ReviewSessionProposal.safeParse({ count: 12 }).success).toBe(false);
  });

  it('a TodayPlan with the old flat proposal still parses (25-event window back-compat)', () => {
    const parsed = TodayPlan.parse({
      daily_focus: '复盘虚词',
      review_session_proposal: { count: 5, estimated_minutes: 20 },
      plan_adjustments: [],
      maintenance_proposals: [],
    });
    expect(parsed.review_session_proposal.knowledge_focus).toEqual([]);
  });
});
