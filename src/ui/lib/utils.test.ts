import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cn, formatCnDate, formatCnDateOnly, formatRelTime } from './utils';

describe('cn', () => {
  it('joins truthy strings with spaces', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });
  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });
  it('returns empty string when all falsy', () => {
    expect(cn(false, null, undefined)).toBe('');
  });
});

describe('formatCnDate', () => {
  it('formats Date to YYYY-MM-DD HH:mm (local time)', () => {
    expect(formatCnDate(new Date(2026, 4, 16, 8, 7))).toBe('2026-05-16 08:07');
  });
  it('accepts ISO string', () => {
    expect(formatCnDate('2026-01-02T03:04:00')).toBe('2026-01-02 03:04');
  });
  it('returns -- for invalid input', () => {
    expect(formatCnDate('not-a-date')).toBe('--');
  });
});

describe('formatCnDateOnly', () => {
  // Pin the runner to UTC+8 (the project's learner timezone) so the day-boundary
  // assertion is deterministic on a UTC CI box; restore afterwards to avoid leaking
  // the override to sibling files in a reused worker.
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Shanghai';
  });
  afterAll(() => {
    // Reflect.deleteProperty (not `delete`, and not `= undefined` which coerces to the
    // string 'undefined') removes the override cleanly when TZ was originally unset.
    if (originalTz === undefined) Reflect.deleteProperty(process.env, 'TZ');
    else process.env.TZ = originalTz;
  });

  it('has the UTC+8 pin in effect (fixture sanity)', () => {
    expect(new Date('2026-07-19T22:00:00.000Z').getHours()).toBe(6);
  });

  it('renders the LOCAL calendar day, not the UTC slice, across the day boundary', () => {
    // 2026-07-19 22:00 UTC = 2026-07-20 06:00 in UTC+8 → the learner is on the 20th.
    const beforeLocalMidnight = new Date('2026-07-19T22:00:00.000Z');
    expect(formatCnDateOnly(beforeLocalMidnight)).toBe('2026-07-20');
    // The old UTC slice would have shown the previous day — guard against a regression.
    expect(beforeLocalMidnight.toISOString().slice(0, 10)).toBe('2026-07-19');
    expect(formatCnDateOnly(beforeLocalMidnight)).not.toBe('2026-07-19');
  });

  it('formats a plain daytime timestamp to its local YYYY-MM-DD', () => {
    expect(formatCnDateOnly(new Date('2026-05-16T04:07:00.000Z'))).toBe('2026-05-16');
  });

  it('returns -- for invalid input', () => {
    expect(formatCnDateOnly('not-a-date')).toBe('--');
  });
});

describe('formatRelTime', () => {
  const now = new Date('2026-05-16T12:00:00Z');

  it('returns 刚刚 for < 10 seconds ago', () => {
    expect(formatRelTime(new Date(now.getTime() - 5_000), now)).toBe('刚刚');
  });
  it('returns N 秒前 for 10–59 seconds', () => {
    expect(formatRelTime(new Date(now.getTime() - 30_000), now)).toBe('30 秒前');
  });
  it('returns N 分钟前 for 1–59 minutes', () => {
    expect(formatRelTime(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 分钟前');
  });
  it('returns N 小时前 for 1–23 hours', () => {
    expect(formatRelTime(new Date(now.getTime() - 3 * 3_600_000), now)).toBe('3 小时前');
  });
  it('returns N 天前 for 1–29 days', () => {
    expect(formatRelTime(new Date(now.getTime() - 7 * 86_400_000), now)).toBe('7 天前');
  });
  it('falls back to formatCnDate beyond 30 days', () => {
    const old = new Date(now.getTime() - 60 * 86_400_000);
    expect(formatRelTime(old, now)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
  it('returns 刚刚 for future time (defensive)', () => {
    expect(formatRelTime(new Date(now.getTime() + 5_000), now)).toBe('刚刚');
  });
  it('returns -- for invalid input', () => {
    expect(formatRelTime('not-a-date', now)).toBe('--');
  });
});
