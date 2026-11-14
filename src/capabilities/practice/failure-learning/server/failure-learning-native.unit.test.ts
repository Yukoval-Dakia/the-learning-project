import { describe, expect, it } from 'vitest';
import type { SlotResponseT } from '@/core/schema/assessment/response';
import { entriesCarryText, photoObservationAnswerMd } from './failure-learning-native';

describe('failure-learning native attribution eligibility', () => {
  // @invariant grading: a photo-only attempt attributes only from frozen grading
  // model observations; no fabricated text is ever substituted for the learner
  // answer, and an attempt with no observations stays out of the paid lane.
  // @fails-if a photo submission with no observations is accepted, or the
  // observation text is passed off as a verified learner answer.
  it('attributes a photo-only attempt only from frozen grading observations', () => {
    const entries: SlotResponseT[] = [{ slot_id: 's1', kind: 'open', text_md: '', evidence: [] }];
    expect(entriesCarryText(entries)).toBe(false);
    expect(photoObservationAnswerMd({ units: [] })).toBeNull();

    const answer = photoObservationAnswerMd({
      units: [
        {
          scoring_unit_id: 'u1',
          part_id: 'p1',
          points_awarded: null,
          points_full: 5,
          reason_md: null,
          wrong_option_ids: [],
          missed_option_ids: [],
          model_observations: [{ slot_id: 's1', evidence_id: 'e1', observation_md: 'wrote 42' }],
        },
      ],
    });
    expect(answer).toContain('u1');
    expect(answer).toContain('wrote 42');
    expect(answer).toContain('未校验');
  });
});
