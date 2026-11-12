// Pure overnight-digest logic (no DB), kept separate so it is unit-testable; the read
// model imports the same functions. This is a read-only observation surface: it counts
// and groups, and never emits internal calibration probabilities.

import type { DegradedKind, OvernightRunGroup } from './overnight-digest';

export type {
  DegradedKind,
  OvernightDigest,
  OvernightRunGroup,
  OvernightWindow,
} from './overnight-digest';

// Asia/Shanghai is fixed UTC+8 (no DST), so the window is deterministic in pure JS. All
// queries receive the same JS-derived UTC instants, avoiding JS/SQL date mixing.
const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The learner's absence is capped: a month away should not turn the digest into a
 * month-long report, and the bounded window also keeps the note-change read cheap.
 */
export const OVERNIGHT_WINDOW_MAX_DAYS = 14;

function bjtDayStartUtcMs(at: Date): number {
  const bjt = new Date(at.getTime() + BJT_OFFSET_MS);
  return Date.UTC(bjt.getUTCFullYear(), bjt.getUTCMonth(), bjt.getUTCDate()) - BJT_OFFSET_MS;
}

/** Whole days the window covers; always at least the single previous night. */
export function overnightWindowDays(window: { from: Date; to: Date }): number {
  const span = window.to.getTime() - window.from.getTime();
  if (!Number.isFinite(span)) return 1;
  return Math.max(1, Math.round(span / DAY_MS));
}

/**
 * "Last night" = the previous Asia/Shanghai calendar day. Without a last-visit anchor
 * the window stays fixed (callers that only have a clock use this form).
 */
export function overnightWindow(now: Date): { from: Date; to: Date } {
  return overnightWindowSince(now, null);
}

/**
 * Window from the day of the learner's last activity through today's BJT midnight,
 * capped at OVERNIGHT_WINDOW_MAX_DAYS. An activity today still shows last night only.
 */
export function overnightWindowSince(
  now: Date,
  lastLearnerEventAt: Date | null,
): { from: Date; to: Date } {
  const todayStartUtcMs = bjtDayStartUtcMs(now);
  const lastNightStartUtcMs = todayStartUtcMs - DAY_MS;
  const earliestStartUtcMs = todayStartUtcMs - OVERNIGHT_WINDOW_MAX_DAYS * DAY_MS;
  const absenceStartUtcMs =
    lastLearnerEventAt === null
      ? lastNightStartUtcMs
      : Math.max(bjtDayStartUtcMs(lastLearnerEventAt), earliestStartUtcMs);
  return {
    from: new Date(Math.min(lastNightStartUtcMs, absenceStartUtcMs)),
    to: new Date(todayStartUtcMs),
  };
}

export interface RunStatusCountRow {
  task_kind: string;
  status: string;
  count: number;
}

/** Group flat counts by task_kind; output is ordered by task_kind for determinism. */
export function groupRunsByKind(rows: RunStatusCountRow[]): OvernightRunGroup[] {
  const byKind = new Map<string, OvernightRunGroup>();
  for (const row of rows) {
    const group = byKind.get(row.task_kind) ?? {
      task_kind: row.task_kind,
      count: 0,
      status_breakdown: {},
    };
    group.count += row.count;
    group.status_breakdown[row.status] = (group.status_breakdown[row.status] ?? 0) + row.count;
    byKind.set(row.task_kind, group);
  }
  return Array.from(byKind.values()).sort((a, b) => a.task_kind.localeCompare(b.task_kind));
}

export interface OvernightActivityParts {
  runs_total: number;
  note_changes_count: number;
  new_proposals_count: number;
  new_conjectures_count: number;
  agent_notes_count: number;
}

/**
 * A quiet night is a first-class state, distinct from loading/failure: all five sources
 * are enumerated here. Add any new nightly source, or quiet nights will under-count.
 */
export function hasOvernightActivity(parts: OvernightActivityParts): boolean {
  return (
    parts.runs_total > 0 ||
    parts.note_changes_count > 0 ||
    parts.new_proposals_count > 0 ||
    parts.new_conjectures_count > 0 ||
    parts.agent_notes_count > 0
  );
}

/**
 * Two independent failures are needed before a kind is flagged; a single transient error
 * is too common to be worth alarming. Counts include only terminal logical failures
 * (isTaskFailureOutcome): retried, sweeper-converged and cancelled help attempts are out.
 */
export const DEGRADED_KIND_ERROR_THRESHOLD = 2;

/** Recent error samples per kind: enough to see a pattern without bloating the payload. */
export const DEGRADED_KIND_SAMPLE_SIZE = 3;

/** Prefix length; a full stack trace would bloat the digest without adding signal. */
export const DEGRADED_KIND_MESSAGE_MAX_LEN = 200;

export interface RunErrorRow {
  task_kind: string;
  error_message: string | null;
  /** ISO-8601 UTC, for newest-first sampling. */
  finished_at: string;
}

/**
 * A scan event whose run executed but whose domain artifact is invalid (the
 * `outcome = 'degraded'` scan contract, agent-run.ts). Different evidence class from
 * RunErrorRow: no execution error, so `degraded_reason` is a short reason code.
 */
export interface DegradedScanRow {
  task_kind: string;
  degraded_reason: string | null;
  /** ISO-8601 UTC event time, for newest-first sampling. */
  occurred_at: string;
}

/** Placeholder keeps null reasons visible in samples. */
export const DEGRADED_SCAN_NO_REASON_PLACEHOLDER = '(no degraded_reason)';

/** Placeholder keeps null messages visible in samples. */
export const DEGRADED_KIND_NO_MESSAGE_PLACEHOLDER = '(no error_message)';

function truncateErrorMessage(msg: string): string {
  if (msg.length <= DEGRADED_KIND_MESSAGE_MAX_LEN) return msg;
  return `${msg.slice(0, DEGRADED_KIND_MESSAGE_MAX_LEN)}…`;
}

/**
 * Group failure rows by task_kind and flag kinds at the threshold, with the most recent
 * truncated messages. Deliberately just group-by + top-N: no cost, dedupe, or baseline.
 *
 * `scanRows` (degraded scan events) are folded in threshold-free: one silently degraded
 * run already is the degradation this flag exists to surface, unlike a single transient
 * execution error. Counts and the newest-first message sample merge across both sources.
 */
export function computeDegradedKinds(
  rows: RunErrorRow[],
  scanRows: DegradedScanRow[] = [],
): DegradedKind[] {
  const byKind = new Map<string, RunErrorRow[]>();
  for (const row of rows) {
    const list = byKind.get(row.task_kind) ?? [];
    list.push(row);
    byKind.set(row.task_kind, list);
  }
  const scansByKind = new Map<string, DegradedScanRow[]>();
  for (const row of scanRows) {
    const list = scansByKind.get(row.task_kind) ?? [];
    list.push(row);
    scansByKind.set(row.task_kind, list);
  }
  const out: DegradedKind[] = [];
  for (const task_kind of new Set([...byKind.keys(), ...scansByKind.keys()])) {
    const errors = byKind.get(task_kind) ?? [];
    const scans = scansByKind.get(task_kind) ?? [];
    if (errors.length < DEGRADED_KIND_ERROR_THRESHOLD && scans.length === 0) continue;
    const samples = [
      ...errors.map((r) => ({
        at: r.finished_at,
        message: truncateErrorMessage(r.error_message ?? DEGRADED_KIND_NO_MESSAGE_PLACEHOLDER),
      })),
      ...scans.map((r) => ({
        at: r.occurred_at,
        message: truncateErrorMessage(r.degraded_reason ?? DEGRADED_SCAN_NO_REASON_PLACEHOLDER),
      })),
    ];
    // Return 0 on ties and rely on stable sort, so same-millisecond samples stay ordered.
    samples.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    out.push({
      task_kind,
      error_count: errors.length + scans.length,
      recent_error_messages: samples.slice(0, DEGRADED_KIND_SAMPLE_SIZE).map((s) => s.message),
      // Samples are newest-first, so the head is the latest failure of this kind.
      last_at: samples[0].at,
    });
  }
  return out.sort((a, b) => a.task_kind.localeCompare(b.task_kind));
}
