import { describe, expect, it } from 'vitest';
import { scheduleReview } from './fsrs';

const NOW = new Date('2026-05-10T12:00:00Z');

describe('scheduleReview', () => {
  it('handles a state round-tripped through DB JSON without breaking ts-fsrs (regression)', async () => {
    const { FsrsState } = await import('@/core/schema/business');
    const first = scheduleReview(null, 'good', NOW);
    const dbShaped = JSON.parse(JSON.stringify(first.nextState)) as unknown;
    expect(typeof (dbShaped as { due: unknown }).due).toBe('string');
    const reparsed = FsrsState.parse(dbShaped);
    expect(reparsed.due).toBeInstanceOf(Date);
    const ONE_DAY_LATER = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const second = scheduleReview(reparsed, 'good', ONE_DAY_LATER);
    expect(Number.isFinite(second.nextState.scheduled_days)).toBe(true);
    expect(Number.isFinite(second.nextState.stability)).toBe(true);
    expect(second.dueAt.getTime()).toBeGreaterThan(ONE_DAY_LATER.getTime());
  });
});
