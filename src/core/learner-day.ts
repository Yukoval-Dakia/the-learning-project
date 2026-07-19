// The single definition of the learner's local calendar day. Every learner-facing
// day boundary in this project is Asia/Shanghai (a fixed UTC+8, no DST), matching the
// house cron domain and the overnight-digest / learner-state day buckets. Pure (no DB,
// no IO) so both the server writer (teaching-brief-interactions.ts) and the offline
// report script can share ONE source and never drift.
//
// `en-CA` formats as a lexically-sortable `YYYY-MM-DD`, so a string range compare over
// these buckets is also a chronological compare (used by the report's window filter).

const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The learner's Asia/Shanghai calendar day (`YYYY-MM-DD`) for an instant. */
export function learnerLocalDay(at: Date): string {
  // Fail loud on an invalid Date rather than letting `Intl.format` emit "Invalid Date" — that
  // string would otherwise flow into a deterministic event id + payload and silently corrupt the
  // ledger (a bad clock / NaN timestamp must surface, not be persisted as a fake bucket).
  if (Number.isNaN(at.getTime())) throw new Error('learnerLocalDay: invalid date');
  return SHANGHAI_DAY_FORMATTER.format(at);
}

/** True when `day` is a well-formed `YYYY-MM-DD` calendar date (no time, no zone). */
export function isLearnerLocalDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  // Round-trip guard: rejects impossible dates (e.g. 2026-02-31) that pass the regex.
  const asUtc = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(asUtc.getTime()) && asUtc.toISOString().slice(0, 10) === day;
}

const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The half-open UTC instant range `[from, to)` covering the inclusive Asia/Shanghai calendar-day
 * range `[fromDay, toDay]`. `from` is `fromDay` 00:00 BJT; `to` is the START of the day AFTER
 * `toDay` (so `toDay` is fully included). Feed the returned instants straight to a `created_at >=
 * from AND created_at < to` filter — one consistent JS-computed instant pair, no JS/SQL timezone
 * mixing (mirrors overnight-digest-summary's window idiom). Throws on a malformed / inverted range.
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
