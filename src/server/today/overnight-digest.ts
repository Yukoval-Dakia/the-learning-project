// Shared overnight facts and loader for Today, Start and Copilot.
// Shell owns the five-source aggregation; Copilot owns its handoff sentence and failure policy.
// The dynamic imports preserve the existing public-port composition and loading boundary.

import type { ProviderCostWindow } from '@/core/schema/cost-observation';
import type { Db, Tx } from '@/db/client';

type DbLike = Db | Tx;

export interface OvernightWindow {
  /** Window start (inclusive): yesterday 00:00 BJT, ISO-8601 UTC. */
  from: string;
  /** Window end (exclusive): today 00:00 BJT, ISO-8601 UTC. */
  to: string;
}

/** Runs for one task_kind in the window, rolled up by status. */
export interface OvernightRunGroup {
  task_kind: string;
  /** Finished runs in the window. */
  count: number;
  /** Status → count for statuses that actually appear in the window. */
  status_breakdown: Record<string, number>;
}

/** A task_kind marked degraded: total errors plus recent samples. */
export interface DegradedKind {
  task_kind: string;
  /** Total errors in the window, not just the messages shown below. */
  error_count: number;
  /** Most recent first; the aggregator truncates long strings. */
  recent_error_messages: string[];
}

/** Five-source overnight facts shared by Today and Copilot. */
export interface OvernightDigest {
  window: OvernightWindow;
  /** All accounting activity in the fixed BJT day; not night-cron-only or billing quota. */
  cost: ProviderCostWindow;
  /** Any of the five sources has a fact; false is an explicit quiet night, never ColdStart. */
  has_overnight_activity: boolean;
  runs: OvernightRunGroup[];
  note_changes_count: number;
  new_proposals_count: number;
  new_conjectures_count: number;
  agent_notes_count: number;
  /** Non-empty implies has_overnight_activity; the reverse does not hold. */
  degraded_kinds: DegradedKind[];
}

export type LoadTodayOvernightDigest = (db: DbLike, now?: Date) => Promise<OvernightDigest>;

/** Canonical read point for the previous BJT calendar day's digest. */
export const loadTodayOvernightDigest: LoadTodayOvernightDigest = async (db, now = new Date()) => {
  const [{ loadOvernightDigest }, { readProviderCostWindow }] = await Promise.all([
    import('@/capabilities/shell/public'),
    import('@/capabilities/observability/public'),
  ]);
  return loadOvernightDigest(db, now, readProviderCostWindow);
};
