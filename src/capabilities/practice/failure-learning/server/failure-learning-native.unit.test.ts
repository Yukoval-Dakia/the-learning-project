import { describe, expect, it } from 'vitest';
import type { SlotResponseT } from '@/core/schema/assessment/response';
import type { NativeAttemptVerdict } from '@/kernel/read-models/assessment-verdict';
import {
  entriesCarryText,
  nativeAttemptAttributable,
  photoObservationAnswerMd,
} from './failure-learning-native';

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

  // @invariant grading: the attribution lane sees the same native outcomes the
  // learner-cause writer accepts — partial verdicts and non-self-report
  // partial_unknown_points — while self-report, correct, pending, and fully
  // unsupported outcomes stay out of paid attribution.
  // @fails-if a partial or partial_unknown attempt is filtered out, or a
  // self-report/correct/pending outcome reaches the paid lane.
  it('admits partial and partial_unknown verdicts but not self-report or correct', () => {
    const verdict = (
      verdict: 'correct' | 'partial' | 'incorrect' | 'unsupported',
      source = 'automatic',
      reason = 'score_partial',
    ): NativeAttemptVerdict =>
      ({
        evaluation_group_id: 'g',
        original: null,
        head: null,
        knowledge_ids: [],
        issuance: {},
        revision: {},
        submission: {},
        original_evaluation_id: null,
        effective: {
          status: 'scored',
          verdict: { verdict, reason },
          row: { provenance: { source } },
        },
      }) as unknown as NativeAttemptVerdict;

    expect(nativeAttemptAttributable(verdict('incorrect'))).toBe(true);
    expect(nativeAttemptAttributable(verdict('partial'))).toBe(true);
    expect(
      nativeAttemptAttributable(verdict('unsupported', 'automatic', 'partial_unknown_points')),
    ).toBe(true);
    expect(
      nativeAttemptAttributable(verdict('unsupported', 'self_report', 'partial_unknown_points')),
    ).toBe(false);
    expect(nativeAttemptAttributable(verdict('correct'))).toBe(false);
    expect(nativeAttemptAttributable(undefined)).toBe(false);
  });
});
