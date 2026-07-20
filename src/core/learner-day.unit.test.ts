// YUK-710 — unit tests for the shared learner-local-day helpers (Asia/Shanghai, fixed UTC+8).

import { describe, expect, it } from 'vitest';
import { isLearnerLocalDay, learnerDayWindowUtc, learnerLocalDay } from './learner-day';

describe('learnerLocalDay (Asia/Shanghai)', () => {
  it('buckets an instant into its Shanghai calendar day', () => {
    // 2026-07-10T01:00:00Z is 09:00 the same day in BJT.
    expect(learnerLocalDay(new Date('2026-07-10T01:00:00.000Z'))).toBe('2026-07-10');
  });

  it('rolls the day at the Shanghai midnight boundary, not UTC midnight', () => {
    // 2026-07-09T16:00:00Z = 2026-07-10T00:00 BJT → already the 10th locally.
    expect(learnerLocalDay(new Date('2026-07-09T16:00:00.000Z'))).toBe('2026-07-10');
    // One minute earlier is still the 9th locally.
    expect(learnerLocalDay(new Date('2026-07-09T15:59:00.000Z'))).toBe('2026-07-09');
  });

  it('throws on an invalid Date rather than bucketing "Invalid Date"', () => {
    // A NaN timestamp must fail loud — never flow "Invalid Date" into a deterministic id / payload.
    expect(() => learnerLocalDay(new Date('not-a-date'))).toThrow();
    expect(() => learnerLocalDay(new Date(Number.NaN))).toThrow();
  });
});

describe('isLearnerLocalDay', () => {
  it('accepts a well-formed YYYY-MM-DD', () => {
    expect(isLearnerLocalDay('2026-07-10')).toBe(true);
  });

  it('rejects malformed or impossible dates', () => {
    expect(isLearnerLocalDay('2026-7-10')).toBe(false);
    expect(isLearnerLocalDay('2026-02-31')).toBe(false);
    expect(isLearnerLocalDay('2026-13-01')).toBe(false);
    expect(isLearnerLocalDay('not-a-date')).toBe(false);
    expect(isLearnerLocalDay('2026-07-10T00:00:00Z')).toBe(false);
  });
});

describe('learnerDayWindowUtc', () => {
  it('maps an inclusive Shanghai-day range to a half-open UTC instant range', () => {
    const { from, to } = learnerDayWindowUtc('2026-07-06', '2026-07-19');
    // 2026-07-06 00:00 BJT = 2026-07-05T16:00:00Z.
    expect(from.toISOString()).toBe('2026-07-05T16:00:00.000Z');
    // Half-open upper bound: start of 2026-07-20 BJT = 2026-07-19T16:00:00Z (so the 19th is included).
    expect(to.toISOString()).toBe('2026-07-19T16:00:00.000Z');
  });

  it('covers a single-day window', () => {
    const { from, to } = learnerDayWindowUtc('2026-07-10', '2026-07-10');
    expect(from.toISOString()).toBe('2026-07-09T16:00:00.000Z');
    expect(to.toISOString()).toBe('2026-07-10T16:00:00.000Z');
    // Exactly 24h wide.
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('throws on a malformed or inverted range', () => {
    expect(() => learnerDayWindowUtc('2026-13-01', '2026-07-10')).toThrow();
    expect(() => learnerDayWindowUtc('2026-07-19', '2026-07-06')).toThrow();
  });
});
