import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { agent_workspace, ai_task_runs, learning_session } from '@/db/schema';
import {
  WORKSPACE_IDLE_TTL_MS,
  type WorkspaceOwner,
  conversationUserActivityAt,
  finalizeWorkspaceRowDeletion,
  requestWorkspaceDeletion,
} from './lifecycle';
import { launcherAvailable, previousClaimEnded } from './storage';

export interface WorkspaceSweepReport {
  skipped?: string;
  reclaimed: number;
  requested: { expired: number; deleted: number; completed: number };
  finalized: number;
  deleted: number;
  failures: { id: string; error: string }[];
}

// Single owner of every delete trigger: copilot marks its session tombstones,
// this sweep translates them (plus expiry and finished task runs) into
// workspace revoking then removal. Copilot code never imports this module —
// the only contract between the two is the learning_session deletion columns
// and the agent_workspace row itself. Every finalize failure is kept on
// last_error and thrown after the pass so the job stays visibly failed; the
// next cron retries it.
export async function sweepAgentWorkspaces(
  db: Db,
  { limit = 64 } = {},
): Promise<WorkspaceSweepReport> {
  const report: WorkspaceSweepReport = {
    reclaimed: 0,
    requested: { expired: 0, deleted: 0, completed: 0 },
    finalized: 0,
    deleted: 0,
    failures: [],
  };
  if (!(await launcherAvailable())) {
    report.skipped = 'launcher_unavailable';
    return report;
  }
  const rows = await db
    .select()
    .from(agent_workspace)
    .where(inArray(agent_workspace.state, ['active', 'revoking', 'tombstoned']))
    .orderBy(agent_workspace.last_activity_at)
    .limit(limit);

  // 1. Reclaim leases whose claimant process is provably dead.
  for (const row of rows) {
    if (row.state !== 'active' || !row.execution_token) continue;
    if (await previousClaimEnded(row.execution_runtime ?? '')) {
      await db
        .update(agent_workspace)
        .set({
          execution_token: null,
          execution_runtime: null,
          last_error: 'workspace_claim_orphaned',
        })
        .where(
          and(
            eq(agent_workspace.id, row.id),
            eq(agent_workspace.execution_token, row.execution_token),
          ),
        );
      report.reclaimed += 1;
    }
  }

  // 2. Translate owner facts into delete requests (re-verified inside the lock).
  const cutoff = Date.now() - WORKSPACE_IDLE_TTL_MS;
  for (const row of rows) {
    if (row.state !== 'active') continue;
    const owner: WorkspaceOwner = { kind: row.owner_kind, id: row.owner_id };
    if (row.owner_kind === 'task') {
      const [run] = await db
        .select({ status: ai_task_runs.status })
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, row.owner_id))
        .limit(1);
      if (run && run.status !== 'running') {
        const before = await requestWorkspaceDeletion(db, owner, 'completed');
        if (before?.state === 'revoking') report.requested.completed += 1;
      } else if (!run) {
        // No run row means we cannot prove the task ended — keep the directory
        // and surface the anomaly instead of guessing an orphan is safe.
        await db
          .update(agent_workspace)
          .set({ last_error: 'workspace_owner_unverifiable' })
          .where(and(eq(agent_workspace.id, row.id), isNull(agent_workspace.last_error)));
      } else if (row.last_activity_at.getTime() <= cutoff) {
        const before = await requestWorkspaceDeletion(db, owner, 'expired');
        if (before?.state === 'revoking') report.requested.expired += 1;
      }
      continue;
    }
    const [session] = await db
      .select({
        id: learning_session.id,
        deleting: sql<boolean>`(${learning_session.deletion_requested_at} IS NOT NULL OR ${learning_session.deleted_at} IS NOT NULL)`,
      })
      .from(learning_session)
      .where(and(eq(learning_session.id, row.owner_id), eq(learning_session.type, 'conversation')))
      .limit(1);
    if (!session) continue;
    if (session.deleting) {
      const before = await requestWorkspaceDeletion(db, owner, 'deleted');
      if (before?.state === 'revoking') report.requested.deleted += 1;
      continue;
    }
    const activity = await conversationUserActivityAt(db, row.owner_id);
    if (activity && activity.getTime() <= cutoff) {
      const before = await requestWorkspaceDeletion(db, owner, 'expired');
      if (before?.state === 'revoking') report.requested.expired += 1;
    }
  }

  // 3. Tombstone then remove; every failure is recorded and rethrown. Retired
  // rows are swept by id — their owner may already hold a new generation.
  const pending = await db
    .select()
    .from(agent_workspace)
    .where(inArray(agent_workspace.state, ['revoking', 'tombstoned', 'retired']))
    .orderBy(agent_workspace.last_activity_at)
    .limit(limit);
  for (const row of pending) {
    try {
      const done = await finalizeWorkspaceRowDeletion(db, row.id);
      report.finalized += 1;
      if (done?.state === 'deleted') report.deleted += 1;
    } catch (error) {
      report.failures.push({
        id: row.id,
        error: error instanceof Error ? error.message : 'workspace_delete_failed',
      });
    }
  }
  if (report.failures.length > 0) {
    throw new AggregateError(
      report.failures.map((f) => new Error(`${f.id}: ${f.error}`)),
      'workspace_sweep_failures',
    );
  }
  return report;
}

// pg-boss factory lives in ../jobs/agent_workspace_sweep.ts so the manifest's
// lazy load path stays one module hop, matching the copilot reconcile shape.
