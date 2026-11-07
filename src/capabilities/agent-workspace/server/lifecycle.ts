import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { agent_workspace, ai_task_runs, learning_session } from '@/db/schema';
import { COPILOT_ASK_ACTIONS } from '@/kernel/events/copilot-actions';
import { lockAgentWorkspacePool } from '@/kernel/locks/agent-workspace-lock';
import { invokeWorkspace } from './executor';
import {
  launcherAvailable,
  poolBytes,
  previousClaimEnded,
  runtimeIdentity,
  volumeIdentity,
  workspaceBytes,
} from './storage';

// Workspace lifecycle owner. A row binds one owner (copilot conversation or a
// logical task run, never an attempt) to one sandbox directory for as long as
// the owner lives. Claims take the pool lock then, for conversations, the
// session row — never the other way — so copilot's selection lock order can
// never deadlock against it. Filesystem effects never happen inside the lock:
// the tombstone commits first, then the directory is removed and CAS-marked.
export type WorkspaceOwner = { kind: 'conversation' | 'task'; id: string };
export type DeleteReason = 'expired' | 'deleted' | 'completed';
export const WORKSPACE_SESSION_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_POOL_BYTES = 1024 * 1024 * 1024;
export const WORKSPACE_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CURRENT_STATES = ['active', 'revoking', 'tombstoned'] as const;

function ownerWhere(owner: WorkspaceOwner) {
  return and(
    eq(agent_workspace.owner_kind, owner.kind),
    eq(agent_workspace.owner_id, owner.id),
    inArray(agent_workspace.state, [...CURRENT_STATES]),
  );
}

export type WorkspaceRow = typeof agent_workspace.$inferSelect;

export async function readWorkspace(
  db: Db | Tx,
  owner: WorkspaceOwner,
): Promise<WorkspaceRow | null> {
  return (await db.select().from(agent_workspace).where(ownerWhere(owner)).limit(1))[0] ?? null;
}

async function requireOwner(tx: Tx, owner: WorkspaceOwner): Promise<void> {
  if (owner.kind === 'task') {
    const [run] = await tx
      .select({ status: ai_task_runs.status })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, owner.id))
      .limit(1);
    if (run?.status !== 'running') throw new Error('workspace_owner_closed');
    return;
  }
  const [session] = await tx
    .select()
    .from(learning_session)
    .where(eq(learning_session.id, owner.id))
    .for('update');
  if (
    session?.type !== 'conversation' ||
    session.entrypoint !== 'copilot' ||
    session.deletion_requested_at ||
    session.deleted_at ||
    !['active', 'idle'].includes(session.status)
  ) {
    throw new Error('workspace_owner_closed');
  }
}

/**
 * Last user activity on a copilot conversation: its asks/chips, floored at
 * creation so an un-asked session is not instantly stale. Derived from the
 * event stream on read — never written back to learning_session.
 */
export async function conversationUserActivityAt(
  tx: Db | Tx,
  sessionId: string,
): Promise<Date | null> {
  const askActions = sql.raw(COPILOT_ASK_ACTIONS.map((a) => `'${a}'`).join(', '));
  const rows = await tx.execute<{ last_activity: string | Date }>(sql`
    SELECT greatest(
      s.created_at,
      coalesce((
        SELECT max(e.created_at) FROM event e
        WHERE e.session_id = s.id
          AND e.action IN (${askActions})
      ), s.created_at)
    ) AS last_activity
    FROM learning_session s WHERE s.id = ${sessionId}
  `);
  const activity = rows[0]?.last_activity;
  return activity == null ? null : new Date(activity);
}

/**
 * Mark the owner's workspace revoking. No filesystem effect here — a later
 * finalize does the durable tombstone then removes the directory. Idempotent;
 * reasons re-verified under the pool lock so a sweep cannot delete a live
 * owner on a stale observation.
 */
export async function requestWorkspaceDeletion(
  db: Db,
  owner: WorkspaceOwner,
  reason: DeleteReason,
) {
  return db.transaction(async (tx) => {
    await lockAgentWorkspacePool(tx);
    const row = await readWorkspace(tx, owner);
    if (row?.state !== 'active') return row;
    if (reason === 'expired') {
      if (owner.kind === 'task') {
        if (row.last_activity_at.getTime() > Date.now() - WORKSPACE_IDLE_TTL_MS) return row;
      } else {
        const activity = await conversationUserActivityAt(tx, owner.id);
        if (!activity || activity.getTime() > Date.now() - WORKSPACE_IDLE_TTL_MS) return row;
      }
    }
    if (reason === 'completed') {
      const [run] = await tx
        .select({ status: ai_task_runs.status })
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, owner.id))
        .limit(1);
      if (!run || run.status === 'running') return row;
    }
    if (reason === 'deleted' && owner.kind === 'conversation') {
      const [session] = await tx
        .select({ id: learning_session.id })
        .from(learning_session)
        .where(
          and(
            eq(learning_session.id, owner.id),
            sql`(${learning_session.deletion_requested_at} IS NOT NULL OR ${learning_session.deleted_at} IS NOT NULL)`,
          ),
        )
        .limit(1);
      if (!session) return row;
    }
    await tx
      .update(agent_workspace)
      .set({ state: 'revoking', delete_reason: reason })
      .where(eq(agent_workspace.id, row.id));
    return readWorkspace(tx, owner);
  });
}

async function claim(db: Db, owner: WorkspaceOwner, mode: 'read' | 'write', reservation: number) {
  if (!(await launcherAvailable())) throw new Error('workspace_unavailable');
  return db.transaction(async (tx) => {
    await lockAgentWorkspacePool(tx);
    await requireOwner(tx, owner);
    const volume = await volumeIdentity();
    let row: Awaited<ReturnType<typeof readWorkspace>> = await readWorkspace(tx, owner);
    if (row && row.volume_id !== volume) {
      // Never rebind a directory from another volume; retire the record and
      // start a new generation on this one.
      if (row.execution_token) throw new Error('workspace_execution_outcome_unknown');
      await tx
        .update(agent_workspace)
        .set({ state: 'retired', last_error: 'workspace_not_restored' })
        .where(eq(agent_workspace.id, row.id));
      row = null;
    }
    if (!row) {
      if (mode !== 'write') throw new Error('workspace_not_found');
      if ((await poolBytes()) >= WORKSPACE_POOL_BYTES) throw new Error('workspace_pool_full');
      const [{ max }] = await tx
        .select({ max: sql<number>`coalesce(max(${agent_workspace.generation}), 0)` })
        .from(agent_workspace)
        .where(
          and(eq(agent_workspace.owner_kind, owner.kind), eq(agent_workspace.owner_id, owner.id)),
        );
      const id = randomBytes(32).toString('hex');
      [row] = await tx
        .insert(agent_workspace)
        .values({
          id,
          owner_kind: owner.kind,
          owner_id: owner.id,
          volume_id: volume,
          generation: max + 1,
        })
        .returning();
    }
    if (row.state !== 'active') throw new Error('workspace_owner_closed');
    if (row.execution_token) {
      // A token from a provably ended claimant is fencing garbage, not a lease.
      if (!(await previousClaimEnded(row.execution_runtime ?? '')))
        throw new Error('workspace_busy');
      await tx
        .update(agent_workspace)
        .set({
          execution_token: null,
          execution_runtime: null,
          last_error: 'workspace_claim_orphaned',
        })
        .where(eq(agent_workspace.id, row.id));
    }
    if (mode === 'write') {
      if (row.bytes + reservation > WORKSPACE_SESSION_BYTES)
        throw new Error('workspace_quota_exceeded');
      if ((await poolBytes()) + reservation >= WORKSPACE_POOL_BYTES)
        throw new Error('workspace_pool_full');
    }
    const token = randomBytes(32).toString('hex');
    const runtime = await runtimeIdentity();
    await tx
      .update(agent_workspace)
      .set({
        execution_token: token,
        execution_runtime: runtime,
        last_activity_at: new Date(),
        last_error: null,
      })
      .where(eq(agent_workspace.id, row.id));
    return { ...row, token };
  });
}

/**
 * Serial lease for one filesystem operation in the owner's directory. The row
 * is re-read on a probe: revocation or a foreign token aborts the run instead
 * of letting a cancelled turn keep writing past a committed delete. The claim
 * is only cleared by this holder's CAS or by proof the claimant's runtime is
 * dead — a watchdog tick is never itself permission to delete.
 */
export async function withWorkspace<T>(
  db: Db,
  owner: WorkspaceOwner,
  mode: 'read' | 'write',
  run: (id: string, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  reservation = 0,
): Promise<T> {
  signal?.throwIfAborted();
  const row = await claim(db, owner, mode, reservation);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let probing = false;
  const timer = setInterval(async () => {
    if (probing) return;
    probing = true;
    try {
      const current = await readWorkspace(db, owner);
      if (current?.execution_token !== row.token || current.state !== 'active')
        controller.abort(new Error('workspace_access_revoked'));
    } catch {
      controller.abort(new Error('workspace_database_unavailable'));
    } finally {
      probing = false;
    }
  }, 500);
  timer.unref();
  try {
    const created = await invokeWorkspace('create', row.id, '');
    if (created.exitCode !== 0) throw new Error(`workspace_create_failed: ${created.output}`);
    if (signal?.aborted) abort();
    controller.signal.throwIfAborted();
    return await run(row.id, controller.signal);
  } finally {
    clearInterval(timer);
    signal?.removeEventListener('abort', abort);
    try {
      await db
        .update(agent_workspace)
        .set({ execution_token: null, execution_runtime: null })
        .where(and(eq(agent_workspace.id, row.id), eq(agent_workspace.execution_token, row.token)));
    } catch {
      // A DB outage leaves a stale token; the sweep reclaims it by proving the
      // claimant runtime ended. It must never mask the caller's real outcome.
    }
    // Best-effort actuals for the next quota check; a revoked delete may remove
    // the directory first, and a failed usage scan must not lose the release.
    try {
      const bytes = await workspaceBytes(row.id);
      await db.update(agent_workspace).set({ bytes }).where(eq(agent_workspace.id, row.id));
    } catch {
      /* usage is reconciling evidence, not a release precondition */
    }
  }
}

/**
 * Durable tombstone then directory delete. The transaction commits
 * `tombstoned` before any filesystem effect so a crash between them still
 * leaves a retriable record. Failures stay visible on `last_error` and are
 * retried by the sweep; a row bound to another volume is never removed blindly.
 */
export async function finalizeWorkspaceDeletion(db: Db, owner: WorkspaceOwner) {
  const current = await readWorkspace(db, owner);
  if (!current) return null;
  return finalizeWorkspaceRowDeletion(db, current.id);
}

export async function finalizeWorkspaceRowDeletion(db: Db, id: string) {
  const readById = async (tx: Db | Tx) =>
    (await tx.select().from(agent_workspace).where(eq(agent_workspace.id, id)).limit(1))[0] ?? null;
  const row = await db.transaction(async (tx) => {
    await lockAgentWorkspacePool(tx);
    const current = await readById(tx);
    // Retired rows also reach this: their directories still occupy the volume.
    if (!current || current.state === 'active' || current.state === 'deleted') return current;
    if (current.execution_token) {
      if (!(await previousClaimEnded(current.execution_runtime ?? ''))) {
        await tx
          .update(agent_workspace)
          .set({ last_error: 'workspace_execution_not_drained' })
          .where(eq(agent_workspace.id, current.id));
        return readById(tx);
      }
      await tx
        .update(agent_workspace)
        .set({ execution_token: null, execution_runtime: null })
        .where(eq(agent_workspace.id, current.id));
    }
    if (current.state === 'revoking' || current.state === 'retired') {
      await tx
        .update(agent_workspace)
        .set({ state: 'tombstoned', tombstoned_at: new Date() })
        .where(eq(agent_workspace.id, current.id));
    }
    return readById(tx);
  });
  if (row?.state !== 'tombstoned') return row;
  // The tombstone is already durable; the volume check only gates the
  // filesystem effect, so a foreign volume stays tombstoned with the error.
  if (row.volume_id !== (await volumeIdentity())) {
    await db
      .update(agent_workspace)
      .set({ last_error: 'workspace_remote_volume' })
      .where(eq(agent_workspace.id, row.id));
    return { ...row, last_error: 'workspace_remote_volume' };
  }
  try {
    const result = await invokeWorkspace('remove', row.id, '');
    if (result.exitCode !== 0) throw new Error(result.output || 'workspace_delete_failed');
    await db
      .update(agent_workspace)
      .set({ state: 'deleted', bytes: 0, deleted_at: new Date(), last_error: null })
      .where(and(eq(agent_workspace.id, row.id), eq(agent_workspace.state, 'tombstoned')));
  } catch (error) {
    await db
      .update(agent_workspace)
      .set({ last_error: error instanceof Error ? error.message : 'workspace_delete_failed' })
      .where(eq(agent_workspace.id, row.id));
    throw error;
  }
  return readById(db);
}
