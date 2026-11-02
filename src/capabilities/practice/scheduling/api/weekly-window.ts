export const DEFAULT_REPORT_TIME_ZONE = 'Asia/Shanghai';

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface CalendarReportWindow {
  from: Date;
  to: Date;
  dateKeys: string[];
  timeZone: string;
}

function formatter(timeZone: string, withTime: boolean): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime
      ? {
          hour: '2-digit' as const,
          minute: '2-digit' as const,
          second: '2-digit' as const,
          hourCycle: 'h23' as const,
        }
      : {}),
  });
}

function numericPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) throw new RangeError(`Missing ${type} in formatted date`);
  return Number(value);
}

function localDateTimeParts(date: Date, timeZone: string): LocalDateTimeParts {
  const parts = formatter(timeZone, true).formatToParts(date);
  return {
    year: numericPart(parts, 'year'),
    month: numericPart(parts, 'month'),
    day: numericPart(parts, 'day'),
    hour: numericPart(parts, 'hour'),
    minute: numericPart(parts, 'minute'),
    second: numericPart(parts, 'second'),
  };
}

export function resolveReportTimeZone(value: string | null | undefined): string {
  const candidate = value?.trim() || DEFAULT_REPORT_TIME_ZONE;
  if (candidate.length > 100) throw new RangeError('Time zone identifier is too long');
  return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
}

export function localDateKey(date: Date, timeZone: string): string {
  const parts = formatter(timeZone, false).formatToParts(date);
  const year = numericPart(parts, 'year');
  const month = numericPart(parts, 'month');
  const day = numericPart(parts, 'day');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) throw new RangeError(`Invalid date key: ${dateKey}`);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function localDayStart(dateKey: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) throw new RangeError(`Invalid date key: ${dateKey}`);

  const targetAsUtc = Date.UTC(year, month - 1, day);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const observed = localDateTimeParts(new Date(candidate), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const correction = targetAsUtc - observedAsUtc;
    candidate += correction;
    if (correction === 0) return new Date(candidate);
  }
  throw new RangeError(`Could not resolve local midnight for ${dateKey} in ${timeZone}`);
}

export function buildCalendarReportWindow(
  now: Date,
  days: number,
  timeZone: string,
): CalendarReportWindow {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new RangeError('Report days must be an integer from 1 to 90');
  }
  const canonicalTimeZone = resolveReportTimeZone(timeZone);
  const today = localDateKey(now, canonicalTimeZone);
  const dateKeys = Array.from({ length: days }, (_, index) =>
    shiftDateKey(today, index - days + 1),
  );
  return {
    from: localDayStart(dateKeys[0], canonicalTimeZone),
    to: now,
    dateKeys,
    timeZone: canonicalTimeZone,
  };
}
