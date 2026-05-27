// T-RA — RatingAdvisor pure-function tests (YUK-98)
//
// Source spec: docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md §6
// Driver: docs/superpowers/plans/2026-05-27-tra-rating-advisor-driver.md §1.1
//
// Maps a JudgeResultV2 (+ optional effective cause category, sourced via
// CC-1's effectiveCauseCategoryForFailureAttempt helper at the call site) to
// an FsrsRating advisory + human-readable reason. Pure function — no IO,
// no DB. CC-1 cause SoT is preserved: the advisor never re-derives cause,
// it only reads the helper output.
//
// Six boundary cases per driver §2:
//   1. score=0.0 (incorrect)
//   2. score=0.4 (partial, no cause)
//   3. score=0.7 (partial, no cause)
//   4. score=1.0 (correct)
//   5. score=0.4 + carelessness-leaning cause
//   6. score=0.4 + conceptual-leaning cause
//
// FsrsRating is the project's 3-state enum (again | hard | good); spec §6.2
// 'easy' branches collapse to 'good' (route.ts:80-82 documents the same
// 3-state UI surface).

import type { JudgeResultV2T } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';
import { judgeResultToRatingAdvice } from './rating-advisor';

const CAPABILITY_REF = { id: 'steps', version: '1' } as const;

function makeIncorrect(): JudgeResultV2T {
  return {
    coarse_outcome: 'incorrect',
    score: 0,
    score_meaning: 'correctness',
    confidence: 0.9,
    capability_ref: CAPABILITY_REF,
    feedback_md: 'answer is wrong',
    evidence_json: {},
  };
}

function makePartial(score: number): JudgeResultV2T {
  return {
    coarse_outcome: 'partial',
    score,
    score_meaning: 'steps_v1_weighted',
    confidence: 0.8,
    capability_ref: CAPABILITY_REF,
    feedback_md: `partial credit ${score}`,
    evidence_json: {},
  };
}

function makeCorrect(score: number): JudgeResultV2T {
  return {
    coarse_outcome: 'correct',
    score,
    score_meaning: 'correctness',
    confidence: 0.95,
    capability_ref: CAPABILITY_REF,
    feedback_md: 'correct',
    evidence_json: {},
  };
}

function makeUnsupported(): JudgeResultV2T {
  return {
    coarse_outcome: 'unsupported',
    score: null,
    score_meaning: 'correctness',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md: 'unsupported route',
    evidence_json: {},
  };
}

describe('judgeResultToRatingAdvice — six boundary cases', () => {
  it('case 1: score=0.0 (incorrect) → again', () => {
    const advice = judgeResultToRatingAdvice(makeIncorrect());
    expect(advice.rating).toBe('again');
    expect(advice.evidence_score).toBe(0);
    expect(advice.reason).toMatch(/incorrect|again/i);
  });

  it('case 2: score=0.4 partial, no cause → good (bucket 0.4-0.7 default)', () => {
    const advice = judgeResultToRatingAdvice(makePartial(0.4));
    expect(advice.rating).toBe('good');
    expect(advice.evidence_score).toBe(0.4);
    expect(advice.reason).toMatch(/partial/i);
  });

  it('case 3: score=0.7 partial, no cause → good (bucket 0.7-1.0 default)', () => {
    const advice = judgeResultToRatingAdvice(makePartial(0.7));
    expect(advice.rating).toBe('good');
    expect(advice.evidence_score).toBe(0.7);
  });

  it('case 4: score=1.0 (correct) → good (bucket 0.7-1.0; easy collapsed to good)', () => {
    const advice = judgeResultToRatingAdvice(makeCorrect(1.0));
    expect(advice.rating).toBe('good');
    expect(advice.evidence_score).toBe(1.0);
    expect(advice.reason).toMatch(/correct/i);
  });

  it('case 5: score=0.4 partial + carelessness-leaning cause → good (bias preserves good)', () => {
    // physics profile uses cause id 'careless'; generic 'carelessness' also accepted.
    const advice = judgeResultToRatingAdvice(makePartial(0.4), { causeCategory: 'careless' });
    expect(advice.rating).toBe('good');
    expect(advice.reason).toMatch(/careless/i);
  });

  it('case 6: score=0.4 partial + conceptual_error cause → again (bias drops two steps)', () => {
    // physics profile uses cause id 'concept'; generic 'conceptual_error' also accepted.
    const advice = judgeResultToRatingAdvice(makePartial(0.4), { causeCategory: 'concept' });
    expect(advice.rating).toBe('again');
    expect(advice.reason).toMatch(/concept/i);
  });
});

describe('judgeResultToRatingAdvice — non-boundary smoke', () => {
  it('low partial (0.1) → hard default (bucket 0.0-0.4)', () => {
    // Driver §1.1: bucket [0.0, 0.4) → "again | hard"; we pick 'hard' as
    // default to keep room for cause lean to either side without collapsing
    // immediately to the floor.
    const advice = judgeResultToRatingAdvice(makePartial(0.1));
    expect(advice.rating).toBe('hard');
    expect(advice.evidence_score).toBe(0.1);
  });

  it('low partial (0.1) + carelessness → good (one step up from hard)', () => {
    const advice = judgeResultToRatingAdvice(makePartial(0.1), { causeCategory: 'careless' });
    expect(advice.rating).toBe('good');
  });

  it('low partial (0.1) + conceptual → again (two steps down from hard, clamped at again)', () => {
    const advice = judgeResultToRatingAdvice(makePartial(0.1), { causeCategory: 'concept' });
    expect(advice.rating).toBe('again');
  });

  it('unsupported judge → rating null with reason explaining', () => {
    const advice = judgeResultToRatingAdvice(makeUnsupported());
    expect(advice.rating).toBeNull();
    expect(advice.evidence_score).toBeNull();
    expect(advice.reason).toMatch(/unsupported/i);
  });

  it('unknown cause category does not change default bucket', () => {
    const advice = judgeResultToRatingAdvice(makePartial(0.4), { causeCategory: 'computation' });
    expect(advice.rating).toBe('good');
  });

  it('correct score=0.85 (lower edge) → good', () => {
    const advice = judgeResultToRatingAdvice(makeCorrect(0.85));
    expect(advice.rating).toBe('good');
  });

  it('partial 0.6 mid-bucket → good', () => {
    const advice = judgeResultToRatingAdvice(makePartial(0.6));
    expect(advice.rating).toBe('good');
  });

  it('conceptual cause never raises rating above default (mid bucket stays or drops)', () => {
    const adviceNoCause = judgeResultToRatingAdvice(makePartial(0.6));
    const adviceConcept = judgeResultToRatingAdvice(makePartial(0.6), {
      causeCategory: 'concept',
    });
    // default at 0.6 is 'good'; concept lean drops by one step max.
    expect(['hard', 'again']).toContain(adviceConcept.rating);
    expect(adviceNoCause.rating).toBe('good');
  });
});
