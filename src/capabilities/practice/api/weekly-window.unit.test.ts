import { describe, expect, it } from 'vitest';
import {
  buildCalendarReportWindow,
  localDateKey,
  localDayStart,
  resolveReportTimeZone,
} from './weekly-window';

describe('weekly report calendar window', () => {
  it('puts an Asia/Shanghai early-morning event on the learner current day', () => {
    const now = new Date('2026-07-12T16:30:00.000Z'); // 07-13 00:30 in Shanghai
    const window = buildCalendarReportWindow(now, 7, 'Asia/Shanghai');

    expect(window.dateKeys).toEqual([
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
    ]);
    expect(window.from.toISOString()).toBe('2026-07-06T16:00:00.000Z');
    expect(localDateKey(new Date('2026-07-12T17:00:00.000Z'), window.timeZone)).toBe('2026-07-13');
  });

  it('uses calendar midnights across a 23-hour DST day', () => {
    const timeZone = 'America/New_York';
    const beforeDst = localDayStart('2026-03-08', timeZone);
    const afterDst = localDayStart('2026-03-09', timeZone);
    const window = buildCalendarReportWindow(new Date('2026-03-09T16:00:00.000Z'), 3, timeZone);

    expect(beforeDst.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(afterDst.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(afterDst.getTime() - beforeDst.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(window.dateKeys).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(window.from.toISOString()).toBe('2026-03-07T05:00:00.000Z');
  });

  it.each([7, 30, 90])('returns exactly %i local dates including today', (days) => {
    const window = buildCalendarReportWindow(
      new Date('2026-07-13T12:00:00.000Z'),
      days,
      'Asia/Shanghai',
    );
    expect(window.dateKeys).toHaveLength(days);
    expect(window.dateKeys.at(-1)).toBe('2026-07-13');
  });

  it('uses an explicit default and rejects invalid IANA identifiers', () => {
    expect(resolveReportTimeZone(null)).toBe('Asia/Shanghai');
    expect(() => resolveReportTimeZone('Mars/Olympus')).toThrow(RangeError);
  });
});
