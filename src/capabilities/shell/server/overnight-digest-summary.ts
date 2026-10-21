// Pure overnight-digest logic (no DB), kept separate so it is unit-testable; the read
// model imports the same functions. This is a read-only observation surface: it counts
// and groups, and never emits internal calibration probabilities.

import type { DegradedKind, OvernightRunGroup } from '@/server/today/overnight-digest';

export type {
  DegradedKind,
  OvernightDigest,
  OvernightRunGroup,
  OvernightWindow,
} from '@/server/today/overnight-digest';

// Asia/Shanghai is fixed UTC+8 (no DST), so the window is deterministic in pure JS. All
// queries receive the same JS-derived UTC instants, avoiding JS/SQL date mixing.
const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Last night" = the previous Asia/Shanghai calendar day, [from, to). The system has no
 * last-visited anchor, so the window is fixed rather than "since last visit".
 */
export function overnightWindow(now: Date): { from: Date; to: Date } {
  const bjt = new Date(now.getTime() + BJT_OFFSET_MS);
  const bjtTodayMidnightWallMs = Date.UTC(
    bjt.getUTCFullYear(),
    bjt.getUTCMonth(),
    bjt.getUTCDate(),
  );
  const todayStartUtcMs = bjtTodayMidnightWallMs - BJT_OFFSET_MS;
  return {
    from: new Date(todayStartUtcMs - DAY_MS),
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
 * is too common to be worth alarming. Counts include only terminal logical failures: the
 * query excludes error_retried and reconciled_stuck rows.
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

/** Placeholder keeps null messages visible in samples. */
export const DEGRADED_KIND_NO_MESSAGE_PLACEHOLDER = '(no error_message)';

function truncateErrorMessage(msg: string): string {
  if (msg.length <= DEGRADED_KIND_MESSAGE_MAX_LEN) return msg;
  return `${msg.slice(0, DEGRADED_KIND_MESSAGE_MAX_LEN)}…`;
}

/**
 * Group failure rows by task_kind and flag kinds at the threshold, with the most recent
 * truncated messages. Deliberately just group-by + top-N: no cost, dedupe, or baseline.
 */
export function computeDegradedKinds(rows: RunErrorRow[]): DegradedKind[] {
  const byKind = new Map<string, RunErrorRow[]>();
  for (const row of rows) {
    const list = byKind.get(row.task_kind) ?? [];
    list.push(row);
    byKind.set(row.task_kind, list);
  }
  const out: DegradedKind[] = [];
  for (const [task_kind, list] of byKind) {
    if (list.length < DEGRADED_KIND_ERROR_THRESHOLD) continue;
    // Return 0 on ties and rely on stable sort, so same-millisecond samples stay ordered.
    const sorted = [...list].sort((a, b) =>
      a.finished_at < b.finished_at ? 1 : a.finished_at > b.finished_at ? -1 : 0,
    );
    const recent_error_messages = sorted
      .slice(0, DEGRADED_KIND_SAMPLE_SIZE)
      .map((r) => truncateErrorMessage(r.error_message ?? DEGRADED_KIND_NO_MESSAGE_PLACEHOLDER));
    out.push({ task_kind, error_count: list.length, recent_error_messages });
  }
  return out.sort((a, b) => a.task_kind.localeCompare(b.task_kind));
}
