import { describe, expect, it } from 'vitest';
import { cn, formatCnDate, formatRelTime } from './utils';

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
