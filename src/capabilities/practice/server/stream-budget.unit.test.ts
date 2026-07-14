import { describe, expect, it } from 'vitest';
import {
  dailyPracticeBudgetMinutes,
  estimateStreamItemMinutes,
  fitStreamToTimeBudget,
  normalizeDailyPracticePace,
} from './stream-budget';

describe('daily practice time budget (YUK-622)', () => {
  it.each([
    ['light', 10],
    ['medium', 20],
    ['dense', 40],
  ] as const)('%s pace maps to %i minutes', (pace, minutes) => {
    expect(dailyPracticeBudgetMinutes(pace)).toBe(minutes);
  });

  it('missing/unknown pace uses the documented medium=20 default', () => {
    expect(normalizeDailyPracticePace(null)).toBe('medium');
    expect(normalizeDailyPracticePace('legacy-value')).toBe('medium');
    expect(dailyPracticeBudgetMinutes(undefined)).toBe(20);
  });

  it('uses one server-side estimate for question and paper', () => {
    expect(estimateStreamItemMinutes('question')).toBe(2);
    expect(estimateStreamItemMinutes('paper')).toBe(10);
  });

  it('keeps earliest due items first, deterministically defers overflow, then fills papers', () => {
    const result = fitStreamToTimeBudget(
      [
        { ref: 'due-1', item_kind: 'question' as const, source: 'decay' },
        { ref: 'variant', item_kind: 'question' as const, source: 'variant' },
        { ref: 'due-2', item_kind: 'question' as const, source: 'decay' },
        { ref: 'due-3', item_kind: 'question' as const, source: 'decay' },
        { ref: 'paper-1', item_kind: 'paper' as const, source: 'paper' },
        { ref: 'paper-2', item_kind: 'paper' as const, source: 'paper' },
      ],
      10,
    );

    expect(result.kept.map((item) => item.ref)).toEqual(['due-1', 'variant', 'due-2', 'due-3']);
    expect(result.estimatedMinutes).toBe(8);
    expect(result.deferredDueCount).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it('defers the due tail instead of exceeding the budget', () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      ref: `due-${index}`,
      item_kind: 'question' as const,
      source: 'decay',
    }));
    const result = fitStreamToTimeBudget(items, 10);
    expect(result.kept.map((item) => item.ref)).toEqual([
      'due-0',
      'due-1',
      'due-2',
      'due-3',
      'due-4',
    ]);
    expect(result.deferredDueCount).toBe(3);
    expect(result.estimatedMinutes).toBe(10);
  });
});
