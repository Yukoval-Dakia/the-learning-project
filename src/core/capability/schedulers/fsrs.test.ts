import { describe, expect, it, vi } from 'vitest';

import type { JudgeResultV2T } from '@/core/schema/capability';
import { fsrsSchedulerCapability } from './fsrs';
import type { ComputeNextFn, SchedulerStepResult } from './types';

const NOW = new Date('2026-05-30T00:00:00.000Z');

function judge(coarse: JudgeResultV2T['coarse_outcome']): JudgeResultV2T {
  // Minimal valid JudgeResultV2 per coarse_outcome (matches the discriminated union).
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
    due: new Date('2026-05-31T00:00:00.000Z'),
    stability: 1,
    difficulty: 5,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 'review',
    last_review: NOW,
  },
  dueAt: new Date('2026-05-31T00:00:00.000Z'),
};

describe('fsrsSchedulerCapability', () => {
  it('declares the fsrs scheduler manifest serving question + question_part', () => {
    expect(fsrsSchedulerCapability.manifest.id).toBe('fsrs');
    expect(fsrsSchedulerCapability.manifest.kind).toBe('scheduler');
    expect(fsrsSchedulerCapability.manifest.supports_activity_kinds).toEqual([
      'question',
      'question_part',
    ]);
  });

  it.each([
    ['correct', 'good'],
    ['partial', 'hard'],
    ['incorrect', 'again'],
  ] as const)(
    'maps coarse_outcome=%s to rating=%s and delegates to computeNext',
    (coarse, rating) => {
      const computeNext = vi.fn<ComputeNextFn>().mockReturnValue(STEP);
      const decision = fsrsSchedulerCapability.run({
        prevState: null,
        judgeResult: judge(coarse),
        now: NOW,
        computeNext,
      });
      expect(decision).toMatchObject({
        rating,
        nextState: STEP.nextState,
        dueAt: STEP.dueAt,
        confidence: 1,
      });
      expect(computeNext).toHaveBeenCalledWith(null, rating, NOW);
    },
  );

  it('returns a null decision for unsupported verdicts without scheduling', () => {
    const computeNext = vi.fn<ComputeNextFn>();
    const decision = fsrsSchedulerCapability.run({
      prevState: null,
      judgeResult: judge('unsupported'),
      now: NOW,
      computeNext,
    });
    expect(decision).toEqual({ rating: null, nextState: null, dueAt: null, confidence: 1 });
    expect(computeNext).not.toHaveBeenCalled();
  });

  it('threads prior state into computeNext', () => {
    const computeNext = vi.fn<ComputeNextFn>().mockReturnValue(STEP);
    fsrsSchedulerCapability.run({
      prevState: STEP.nextState,
      judgeResult: judge('correct'),
      now: NOW,
      computeNext,
    });
    expect(computeNext).toHaveBeenCalledWith(STEP.nextState, 'good', NOW);
  });
});
