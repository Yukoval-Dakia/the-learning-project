// Read-only last-night digest over the five nightly sources (degraded scan events fold
// into degraded_kinds, not a sixth activity source). It never writes, never emits
// calibration numbers, and keeps a quiet night as an explicit state. The window is
// the previous Asia/Shanghai calendar day (fixed UTC+8, no last-visited anchor).

import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { ProviderCostWindow } from '@/core/schema/cost-observation';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs, event } from '@/db/schema';
import { countProposalsInWindow } from '@/kernel/proposals/inbox';
import { listNoteRefineChanges } from '@/kernel/read-models/note-refine-changes';
import {
  type DegradedScanRow,
  type OvernightDigest,
  type RunErrorRow,
  type RunStatusCountRow,
  computeDegradedKinds,
  groupRunsByKind,
  hasOvernightActivity,
  overnightWindow,
} from './overnight-digest-summary';

export type {
  DegradedKind,
  OvernightDigest,
  OvernightRunGroup,
  OvernightWindow,
} from './overnight-digest-summary';

type DbLike = Db | Tx;

// Deliberately not readAllAgentNotes: that read filters unexpired rows and limits to 20,
// while the digest needs a historical window count including rows that have since expired.
async function countAgentNotesInWindow(db: DbLike, from: Date, to: Date): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:agent_note'),
        eq(event.subject_kind, 'query'),
        gte(event.created_at, from),
        lt(event.created_at, to),
      ),
    );
  return row?.c ?? 0;
}

// finished_at may be null; gte/lt excludes unfinished rows, so only last night's
// completed runs are counted.
async function loadRunRows(db: DbLike, from: Date, to: Date): Promise<RunStatusCountRow[]> {
  const rows = await db
    .select({
      task_kind: ai_task_runs.task_kind,
      status: ai_task_runs.status,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(ai_task_runs)
    .where(and(gte(ai_task_runs.finished_at, from), lt(ai_task_runs.finished_at, to)))
    .groupBy(ai_task_runs.task_kind, ai_task_runs.status);
  return rows.map((r) => ({ task_kind: r.task_kind, status: r.status, count: r.count }));
}

// listNoteRefineChanges only takes a lower bound; trim to < to in JS. The window is one
// day, so the row count is bounded.
async function countNoteChangesInWindow(db: DbLike, from: Date, to: Date): Promise<number> {
  const rows = await listNoteRefineChanges(db, { since: from });
  return rows.filter((r) => r.created_at < to).length;
}

// Raw failure rows; separate from loadRunRows because the sample needs error_message.
//
// status='failure' is the only terminal failure writer; exclude non-failures:
// error_retried (a retried attempt is not the final outcome) and reconciled_stuck
// (sweeper convergence is not a task failure).
async function loadErrorRunRows(db: DbLike, from: Date, to: Date): Promise<RunErrorRow[]> {
  const rows = await db
    .select({
      task_kind: ai_task_runs.task_kind,
      error_message: ai_task_runs.error_message,
      finished_at: ai_task_runs.finished_at,
    })
    .from(ai_task_runs)
    .where(
      and(
        eq(ai_task_runs.status, 'failure'),
        sql`${ai_task_runs.finish_reason} IS DISTINCT FROM 'error_retried'`,
        sql`${ai_task_runs.finish_reason} IS DISTINCT FROM 'reconciled_stuck'`,
        gte(ai_task_runs.finished_at, from),
        lt(ai_task_runs.finished_at, to),
      ),
    )
    .orderBy(desc(ai_task_runs.finished_at));
  return rows.map((r) => ({
    task_kind: r.task_kind,
    error_message: r.error_message,
    // gte/lt 对 timestamp 列比较已排除 finished_at 为 null 的行，故此处必为 Date。
    finished_at: (r.finished_at as Date).toISOString(),
  }));
}

/**
 * Events whose run executed but whose domain artifact is invalid — currently the
 * `outcome = 'degraded'` scan contract (runAgencyProposalScan, agency capability). The
 * query is deliberately generic on `outcome='degraded'` (no action filter): any future
 * writer adopting the same contract is marked here without a digest change. The run
 * itself is already counted in `runs` via ai_task_runs (status='success'); this row is
 * the domain-validity signal that status cannot carry. task_kind comes from
 * the run join; actor_ref (the surface, e.g. 'coach') is the fallback when the run row
 * is gone. payload.degraded_reason is the surface's generic reason code.
 */
async function loadDegradedScanRows(db: DbLike, from: Date, to: Date): Promise<DegradedScanRow[]> {
  const rows = await db
    .select({
      task_kind: sql<string>`coalesce(${ai_task_runs.task_kind}, ${event.actor_ref})`,
      degraded_reason: sql<string | null>`${event.payload}->>'degraded_reason'`,
      occurred_at: event.created_at,
    })
    .from(event)
    .leftJoin(ai_task_runs, eq(event.task_run_id, ai_task_runs.id))
    .where(
      and(eq(event.outcome, 'degraded'), gte(event.created_at, from), lt(event.created_at, to)),
    )
    .orderBy(desc(event.created_at));
  return rows.map((r) => ({
    task_kind: r.task_kind,
    degraded_reason: r.degraded_reason,
    occurred_at:
      r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
  }));
}

/**
 * 昨夜 digest 读模型。聚五个夜间事实源到一个 payload，纯读零写（红线①③）。
 * has_overnight_activity 由五源 count 显式组合（红线②）；内部校准概率永不进 payload（红线④）。
 *
 * Shared digest composition supplies the clock and canonical cost reader.
 * The cost projection owns accounting authority and deduplication.
 */
export async function loadOvernightDigest(
  db: DbLike,
  now: Date,
  readCosts: (db: DbLike, from: Date, to: Date) => Promise<ProviderCostWindow>,
): Promise<OvernightDigest> {
  const { from, to } = overnightWindow(now);

  const [
    runRows,
    noteChangesCount,
    agentNotesCount,
    proposalCounts,
    errorRunRows,
    degradedScanRows,
    cost,
  ] = await Promise.all([
    loadRunRows(db, from, to),
    countNoteChangesInWindow(db, from, to),
    countAgentNotesInWindow(db, from, to),
    countProposalsInWindow(db, { from, to }),
    loadErrorRunRows(db, from, to),
    loadDegradedScanRows(db, from, to),
    readCosts(db, from, to),
  ]);

  const runs = groupRunsByKind(runRows);
  const runsTotal = runs.reduce((acc, g) => acc + g.count, 0);
  // proposals 与 conjectures 不重叠：new_proposals = 全部 proposals − conjectures 子集。
  const newProposalsCount = proposalCounts.total - proposalCounts.conjectures;
  const newConjecturesCount = proposalCounts.conjectures;
  const degradedKinds = computeDegradedKinds(errorRunRows, degradedScanRows);

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    has_overnight_activity: hasOvernightActivity({
      runs_total: runsTotal,
      note_changes_count: noteChangesCount,
      new_proposals_count: newProposalsCount,
      new_conjectures_count: newConjecturesCount,
      agent_notes_count: agentNotesCount,
    }),
    runs,
    note_changes_count: noteChangesCount,
    new_proposals_count: newProposalsCount,
    new_conjectures_count: newConjecturesCount,
    agent_notes_count: agentNotesCount,
    degraded_kinds: degradedKinds,
    cost,
  };
}
