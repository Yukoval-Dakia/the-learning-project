import { describe, expect, it } from 'vitest';
import { applyCauseLeanToAutomaticRating } from './settle-plan';

describe('applyCauseLeanToAutomaticRating', () => {
  // @invariant grading: the settled automatic rating is deterministic in (verdict, base rating, effective cause lean) — same partial score and same cause always produce the same schedule, at both the group receipt and the per-KC card level
  // @fails-if a partial verdict's carelessness cause stops opening toward good, or a conceptual cause stops holding at again on either the group rating or an up-observed KC card; non-partial verdicts must ignore the lean
  it.each([
    // partial + carelessness lean opens the schedule toward good
    ['partial', 'hard', 1, 'good'],
    // partial + conceptual lean holds at again
    ['partial', 'hard', -1, 'again'],
    // partial + no declared lean keeps the base bucket
    ['partial', 'hard', 0, 'hard'],
    // per-KC up observation on a partial verdict: same lean, same direction
    ['partial', 'good', 1, 'good'],
    ['partial', 'good', -1, 'again'],
    ['partial', 'good', 0, 'good'],
    // correct/incorrect/unsupported ignore the cause entirely
    ['correct', 'good', -1, 'good'],
    ['correct', 'easy', 1, 'easy'],
    ['incorrect', 'again', 1, 'again'],
    ['unsupported', null, 1, null],
    ['unsupported', null, -1, null],
  ] as const)(
    'verdict=%s base=%s lean=%s ⇒ %s',
    (verdict, baseAutomaticRating, causeLean, expected) => {
      expect(applyCauseLeanToAutomaticRating(verdict, baseAutomaticRating, causeLean)).toBe(
        expected,
      );
    },
  );
});
