// Single definition of the learner's calendar day: Asia/Shanghai (fixed UTC+8, no DST).
// Pure, so server writers and offline reports share one boundary and never drift.
// `en-CA` yields a lexically sortable YYYY-MM-DD; string range compares are chronological.

const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The learner's Asia/Shanghai calendar day (YYYY-MM-DD) for an instant. */
export function learnerLocalDay(at: Date): string {
  // Fail loud: "Invalid Date" would become a deterministic event id/payload and corrupt
  // the ledger instead of surfacing a bad clock.
  if (Number.isNaN(at.getTime())) throw new Error('learnerLocalDay: invalid date');
  return SHANGHAI_DAY_FORMATTER.format(at);
}

/** True when `day` is a well-formed YYYY-MM-DD calendar date (no time or zone). */
export function isLearnerLocalDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  // Round-trip rejects impossible dates such as 2026-02-31.
  const asUtc = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(asUtc.getTime()) && asUtc.toISOString().slice(0, 10) === day;
}

const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Product week: Monday 00:00 inclusive to next Monday 00:00 exclusive, in
 * Asia/Shanghai (not the dev-account Saturday week). Returns UTC instants for
 * half-open SQL filters; cost rows use their canonical occurred/finished instant.
 */
export function learnerLocalWeekWindowUtc(at: Date): { from: Date; to: Date } {
  if (Number.isNaN(at.getTime())) throw new Error('learnerLocalWeekWindowUtc: invalid date');
  const bjtMs = at.getTime() + BJT_OFFSET_MS;
  const bjtDayStartMs = Math.floor(bjtMs / DAY_MS) * DAY_MS;
  const bjtWeekday = new Date(bjtDayStartMs).getUTCDay(); // 0=Sun … 6=Sat
  const daysSinceMonday = (bjtWeekday + 6) % 7;
  const weekStartUtcMs = bjtDayStartMs - daysSinceMonday * DAY_MS - BJT_OFFSET_MS;
  return { from: new Date(weekStartUtcMs), to: new Date(weekStartUtcMs + WEEK_MS) };
}

/**
 * UTC half-open range covering the inclusive Asia/Shanghai day range [fromDay, toDay].
 * `to` is the start of the day after `toDay`, so one JS-computed pair feeds
 * `created_at >= from AND created_at < to` without JS/SQL timezone mixing.
 */
export function learnerDayWindowUtc(fromDay: string, toDay: string): { from: Date; to: Date } {
  if (!isLearnerLocalDay(fromDay)) throw new Error(`invalid from day: ${fromDay}`);
  if (!isLearnerLocalDay(toDay)) throw new Error(`invalid to day: ${toDay}`);
  if (fromDay > toDay) throw new Error(`inverted range: ${fromDay} > ${toDay}`);
  // `YYYY-MM-DD` 00:00 BJT wall clock = that midnight in UTC minus the fixed +8h offset.
  const fromMidnightUtcMs = Date.parse(`${fromDay}T00:00:00.000Z`) - BJT_OFFSET_MS;
  const toMidnightUtcMs = Date.parse(`${toDay}T00:00:00.000Z`) - BJT_OFFSET_MS;
  return {
    from: new Date(fromMidnightUtcMs),
    to: new Date(toMidnightUtcMs + DAY_MS),
  };
}
