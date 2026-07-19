// YUK-734 — table-driven coverage for the practice copy of ratingFromCoarseOutcome
// (judge coarse_outcome → FSRS rating). This copy is consumed on live submit paths
// (paper-submit.ts, api/submit.ts, api/advice.ts) and is a deliberate DUPLICATE of the
// inline copy in src/core/capability/schedulers/fsrs.ts (core stays free of any
// src/server import). Only the core copy was table-tested; this pins the practice copy
// AND adds a drift guard so the two can never silently diverge.

import { fsrsSchedulerCapability } from '@/core/capability/schedulers/fsrs';
import type { ComputeNextFn, SchedulerStepResult } from '@/core/capability/schedulers/types';
import type { JudgeResultV2T } from '@/core/schema/capability';
import { describe, expect, it, vi } from 'vitest';
import { ratingFromCoarseOutcome } from './judge-rating';

type CoarseOutcome = JudgeResultV2T['coarse_outcome'];

const NOW = new Date('2026-07-20T00:00:00.000Z');

// Minimal valid JudgeResultV2 per coarse_outcome (matches the discriminated union),
// mirroring src/core/capability/schedulers/fsrs.test.ts's helper so the drift guard
// drives the core copy through the exact same input shape.
function judge(coarse: CoarseOutcome): JudgeResultV2T {
  const base = {
    score_meaning: 'correctness' as const,
    confidence: 1,
    capability_ref: { id: 'exact', version: '1.0.0' },
    evidence_json: {},
  };
  switch (coarse) {
    case 'correct':
      return { ...base, coarse_outcome: 'correct', score: 1, feedback_md: 'ok' };
    case 'partial':
      return { ...base, coarse_outcome: 'partial', score: 0.5, feedback_md: 'partial' };
    case 'incorrect':
      return { ...base, coarse_outcome: 'incorrect', score: 0, feedback_md: 'wrong' };
    case 'unsupported':
      return {
        ...base,
        coarse_outcome: 'unsupported',
        score: null,
        confidence: 0,
        feedback_md: 'n/a',
      };
  }
}

const STEP: SchedulerStepResult = {
  nextState: {
    due: new Date('2026-07-21T00:00:00.000Z'),
    stability: 1,
    difficulty: 5,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 'review',
    last_review: NOW,
  },
  dueAt: new Date('2026-07-21T00:00:00.000Z'),
};

describe('ratingFromCoarseOutcome (practice copy)', () => {
  // Full-enumeration table test — every coarse outcome incl. the unsupported → null
  // branch that drives the `?? 'again'` fallback at paper-submit.ts.
  it.each([
    ['correct', 'good'],
    ['partial', 'hard'],
    ['incorrect', 'again'],
    ['unsupported', null],
  ] as const)('maps coarse_outcome=%s to rating=%s', (outcome, rating) => {
    expect(ratingFromCoarseOutcome(outcome)).toBe(rating);
  });

  // Drift guard: the practice copy and the core scheduler copy must agree on EVERY
  // coarse outcome. The core copy is not exported (only fsrsSchedulerCapability is),
  // so drive it via run() with a stub computeNext and compare the resulting rating.
  it.each(['correct', 'partial', 'incorrect', 'unsupported'] as const)(
    'agrees with the core fsrs scheduler copy for coarse_outcome=%s',
    async (outcome) => {
      const computeNext = vi.fn<ComputeNextFn>().mockReturnValue(STEP);
      // run()'s interface return type is SchedulingDecision | Promise<SchedulingDecision>
      // (the fsrs impl is sync); await narrows it to SchedulingDecision and is a no-op on
      // the sync value, so `.rating` type-checks.
      const decision = await fsrsSchedulerCapability.run({
        prevState: null,
        judgeResult: judge(outcome),
        now: NOW,
        computeNext,
      });
      // run() returns rating:null for unsupported (no scheduling) and the mapped rating
      // otherwise — both equal the practice copy's output for the same outcome.
      expect(decision.rating).toBe(ratingFromCoarseOutcome(outcome));
    },
  );
});
