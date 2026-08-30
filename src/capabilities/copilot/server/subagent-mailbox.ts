import { randomUUID } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs, copilot_continuation, event, subagent_run } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { writeEvent } from '@/kernel/events';
import { COPILOT_SUBAGENT_NAME, type CopilotTaskLifecycleMessage } from './subagents';

export const SUBAGENT_RUN_QUEUE = 'copilot_subagent_run';
export const COPILOT_CONTINUATION_QUEUE = 'copilot_continuation';
export const SUBAGENT_RECONCILE_QUEUE = 'copilot_subagent_reconcile';
export const SUBAGENT_WAIT_MAX_MS = 5_000;
export const SUBAGENT_LEASE_MS = 30_000;
export const SUBAGENT_HARD_DEADLINE_MS = 12 * 60_000;
export const SUBAGENT_OBJECTIVE_MAX_CHARS = 12_000;
export const SUBAGENT_RESULT_MAX_CHARS = 60_000;
/** Foreground inline native Task uses the SDK task_id as the durable launch key. */
export const NATIVE_SUBAGENT_LAUNCH_KEY_MAX_CHARS = 120;

export type SubagentRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'lost';
export type ContinuationStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'lost'
  | 'skipped';
export type CancellationOwner = 'model' | 'system' | 'user';

export interface SubagentRunRecord {
  id: string;
  sessionId: string;
  parentTurnEventId: string;
  launchKey: string;
  parentTaskRunId: string | null;
  status: SubagentRunStatus;
  objective: string;
  childTaskRunId: string | null;
  pgBossJobId: string | null;
  startedEventId: string;
  settledEventId: string | null;
  result: string | null;
  error: { code: string; message: string } | null;
  cancelRequestedBy: CancellationOwner | null;
}

export interface CopilotContinuationRecord {
  id: string;
  subagentRunId: string;
  sessionId: string;
  parentTurnEventId: string;
  resultEventId: string;
  status: ContinuationStatus;
  taskRunId: string | null;
  replyEventId: string | null;
}

type DbLike = Db | Tx;
type RunRow = typeof subagent_run.$inferSelect;

function matchesParentTaskRunId(parentTaskRunId: string) {
  return or(
    eq(subagent_run.parent_task_run_id, parentTaskRunId),
    and(
      sql`left(${subagent_run.parent_task_run_id}, char_length(${parentTaskRunId})) = ${parentTaskRunId}`,
      sql`substring(${subagent_run.parent_task_run_id} from char_length(${parentTaskRunId}) + 1) ~ '^_retry_[1-9][0-9]*$'`,
    ),
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 12)}…[truncated]`;
}

function mapRun(row: RunRow): SubagentRunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentTurnEventId: row.parent_turn_event_id,
    launchKey: row.launch_key,
    parentTaskRunId: row.parent_task_run_id,
    status: row.status as SubagentRunStatus,
    objective: row.objective,
    childTaskRunId: row.child_task_run_id,
    pgBossJobId: row.pg_boss_job_id,
    startedEventId: row.started_event_id,
    settledEventId: row.settled_event_id,
    result: row.result_md,
    error:
      row.error_code && row.error_message
        ? { code: row.error_code, message: row.error_message }
        : null,
    cancelRequestedBy: row.cancel_requested_by as CancellationOwner | null,
  };
}

export async function getSubagentRun(db: DbLike, runId: string): Promise<SubagentRunRecord> {
  const [row] = await db.select().from(subagent_run).where(eq(subagent_run.id, runId)).limit(1);
  if (!row) throw new Error('subagent run not found');
  return mapRun(row);
}

export async function getOwnedSubagentRun(
  db: DbLike,
  runId: string,
  sessionId: string,
): Promise<SubagentRunRecord> {
  const record = await getSubagentRun(db, runId);
  if (record.sessionId !== sessionId) throw new Error('subagent run not found');
  return record;
}

export async function launchSubagentRun(
  db: Db,
  input: {
    sessionId: string;
    parentTurnEventId: string;
    parentTaskRunId?: string | null;
    launchKey: string;
    objective: string;
  },
): Promise<{ record: SubagentRunRecord; created: boolean }> {
  const launchKey = input.launchKey.trim();
  const objective = input.objective.trim();
  if (launchKey.length < 1 || launchKey.length > 120)
    throw new Error('launch_key must be 1..120 characters');
  if (objective.length < 1 || objective.length > SUBAGENT_OBJECTIVE_MAX_CHARS) {
    throw new Error(`objective must be 1..${SUBAGENT_OBJECTIVE_MAX_CHARS} characters`);
  }
  const objectiveHash = sha256CanonicalJson({ objective });
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`subagent:${input.sessionId}:${input.parentTurnEventId}:${launchKey}`}, 0))`,
    );
    const [parent] = await tx
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.id, input.parentTurnEventId),
          eq(event.session_id, input.sessionId),
          inArray(event.action, [
            'experimental:copilot_user_ask',
            'experimental:copilot_chip_trigger',
          ]),
        ),
      )
      .limit(1);
    if (!parent) throw new Error('subagent parent turn not found');
    const [existing] = await tx
      .select()
      .from(subagent_run)
      .where(
        and(
          eq(subagent_run.session_id, input.sessionId),
          eq(subagent_run.parent_turn_event_id, input.parentTurnEventId),
          eq(subagent_run.launch_key, launchKey),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.objective_hash !== objectiveHash) {
        throw new Error('launch_key is already bound to different canonical input');
      }
      return { record: mapRun(existing), created: false };
    }
    const id = `subagent_run_${createId()}`;
    const startedEventId = `subagent_started_${id}`;
    const now = new Date();
    const [created] = await tx
      .insert(subagent_run)
      .values({
        id,
        session_id: input.sessionId,
        parent_turn_event_id: input.parentTurnEventId,
        launch_key: launchKey,
        parent_task_run_id: input.parentTaskRunId ?? null,
        objective_hash: objectiveHash,
        objective,
        started_event_id: startedEventId,
        created_at: now,
        updated_at: now,
      })
      .returning();
    if (!created) throw new Error('subagent run insert failed');
    await writeEvent(tx, {
      id: startedEventId,
      session_id: input.sessionId,
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: 'experimental:subagent_run_started',
      subject_kind: 'subagent_run',
      subject_id: id,
      outcome: null,
      payload: { run_id: id, launch_key: launchKey, objective },
      caused_by_event_id: input.parentTurnEventId,
      task_run_id: input.parentTaskRunId ?? null,
      ingest_at: now,
      created_at: now,
    });
    return { record: mapRun(created), created: true };
  });
}

export async function attachSubagentJobId(db: DbLike, runId: string, jobId: string): Promise<void> {
  await db
    .update(subagent_run)
    .set({ pg_boss_job_id: jobId, updated_at: new Date() })
    .where(and(eq(subagent_run.id, runId), isNull(subagent_run.pg_boss_job_id)));
}

export async function attachContinuationJobId(
  db: DbLike,
  continuationId: string,
  jobId: string,
): Promise<void> {
  await db
    .update(copilot_continuation)
    .set({ pg_boss_job_id: jobId, updated_at: new Date() })
    .where(
      and(eq(copilot_continuation.id, continuationId), isNull(copilot_continuation.pg_boss_job_id)),
    );
}

export async function waitSubagentRun(
  db: DbLike,
  runId: string,
  sessionId: string,
  timeoutMs: number,
  pollIntervalMs = 50,
): Promise<SubagentRunRecord> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > SUBAGENT_WAIT_MAX_MS) {
    throw new Error(`timeout_ms must be an integer between 0 and ${SUBAGENT_WAIT_MAX_MS}`);
  }
  const deadline = Date.now() + timeoutMs;
  do {
    const record = await getOwnedSubagentRun(db, runId, sessionId);
    if (record.status !== 'queued' && record.status !== 'running') return record;
    if (Date.now() >= deadline) return record;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())),
    );
  } while (Date.now() <= deadline);
  return getOwnedSubagentRun(db, runId, sessionId);
}

export async function claimSubagentRun(
  db: Db,
  runId: string,
): Promise<{ record: SubagentRunRecord; claimToken: string } | { lost: SubagentRunRecord } | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(subagent_run)
      .where(eq(subagent_run.id, runId))
      .for('update');
    if (!row || !['queued', 'running'].includes(row.status)) return null;
    if (row.status === 'running') {
      if (row.lease_expires_at && row.lease_expires_at.getTime() > now.getTime()) return null;
      const lost = await settleSubagentRunTx(tx, row, {
        status: 'lost',
        error: {
          code: 'provider_fence_reclaimed',
          message: 'Worker ownership ended after provider execution began',
        },
      });
      return { lost };
    }
    if (row.cancel_requested_by) {
      const cancelled = await settleSubagentRunTx(tx, row, {
        status: 'cancelled',
        error: {
          code: 'cancelled_before_start',
          message: 'Subagent cancelled before provider execution',
        },
      });
      return { lost: cancelled };
    }
    const claimToken = randomUUID();
    const childTaskRunId = `copilot_research_${runId}`;
    const [claimed] = await tx
      .update(subagent_run)
      .set({
        status: 'running',
        claim_token: claimToken,
        lease_expires_at: new Date(now.getTime() + SUBAGENT_LEASE_MS),
        hard_deadline_at: new Date(now.getTime() + SUBAGENT_HARD_DEADLINE_MS),
        child_task_run_id: childTaskRunId,
        started_at: now,
        updated_at: now,
      })
      .where(eq(subagent_run.id, runId))
      .returning();
    if (!claimed) return null;
    return { record: mapRun(claimed), claimToken };
  });
}

export async function heartbeatSubagentRun(
  db: DbLike,
  runId: string,
  claimToken: string,
): Promise<'renewed' | 'deadline_reached' | 'not_owned'> {
  const now = new Date();
  const [owned] = await db
    .select({ hardDeadlineAt: subagent_run.hard_deadline_at })
    .from(subagent_run)
    .where(
      and(
        eq(subagent_run.id, runId),
        eq(subagent_run.status, 'running'),
        eq(subagent_run.claim_token, claimToken),
      ),
    )
    .limit(1);
  if (!owned) return 'not_owned';
  if (owned.hardDeadlineAt && owned.hardDeadlineAt.getTime() <= now.getTime()) {
    return 'deadline_reached';
  }
  const leaseExpiresAt = new Date(
    Math.min(
      now.getTime() + SUBAGENT_LEASE_MS,
      owned.hardDeadlineAt?.getTime() ?? now.getTime() + SUBAGENT_LEASE_MS,
    ),
  );
  const rows = await db
    .update(subagent_run)
    .set({
      lease_expires_at: leaseExpiresAt,
      updated_at: now,
    })
    .where(
      and(
        eq(subagent_run.id, runId),
        eq(subagent_run.status, 'running'),
        eq(subagent_run.claim_token, claimToken),
        or(isNull(subagent_run.hard_deadline_at), gt(subagent_run.hard_deadline_at, now)),
      ),
    )
    .returning({ id: subagent_run.id });
  return rows.length === 1 ? 'renewed' : 'deadline_reached';
}

async function settleSubagentRunTx(
  tx: Tx,
  row: RunRow,
  outcome:
    | { status: 'succeeded'; result: string }
    | { status: 'failed' | 'cancelled' | 'lost'; error: { code: string; message: string } },
  options: { mintContinuation?: boolean } = {},
): Promise<SubagentRunRecord> {
  const mintContinuation = options.mintContinuation ?? true;
  const now = new Date();
  const settledEventId = `subagent_settled_${row.id}`;
  const result =
    outcome.status === 'succeeded' ? truncate(outcome.result, SUBAGENT_RESULT_MAX_CHARS) : null;
  const error =
    outcome.status === 'succeeded'
      ? null
      : {
          code: truncate(outcome.error.code || 'unknown', 100),
          message: truncate(outcome.error.message || 'Unknown subagent error', 4_000),
        };
  const [settled] = await tx
    .update(subagent_run)
    .set({
      status: outcome.status,
      result_md: result,
      error_code: error?.code ?? null,
      error_message: error?.message ?? null,
      settled_event_id: settledEventId,
      settled_at: now,
      lease_expires_at: null,
      updated_at: now,
    })
    .where(and(eq(subagent_run.id, row.id), inArray(subagent_run.status, ['queued', 'running'])))
    .returning();
  if (!settled) return getSubagentRun(tx, row.id);
  await writeEvent(tx, {
    id: settledEventId,
    session_id: row.session_id,
    actor_kind: 'agent',
    actor_ref: 'agent:copilot-researcher',
    action: 'experimental:subagent_run_settled',
    subject_kind: 'subagent_run',
    subject_id: row.id,
    outcome: outcome.status === 'succeeded' ? 'success' : 'failure',
    payload: {
      run_id: row.id,
      status: outcome.status,
      ...(result ? { result_md: result } : {}),
      ...(error ? { error } : {}),
    },
    caused_by_event_id: row.started_event_id,
    task_run_id: row.child_task_run_id,
    ingest_at: now,
    created_at: now,
  });
  if (mintContinuation) {
    await tx
      .insert(copilot_continuation)
      .values({
        id: `copilot_continuation_${row.id}`,
        subagent_run_id: row.id,
        session_id: row.session_id,
        parent_turn_event_id: row.parent_turn_event_id,
        result_event_id: settledEventId,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing({ target: copilot_continuation.subagent_run_id });
  }
  return mapRun(settled);
}

export async function settleSubagentRun(
  db: Db,
  runId: string,
  claimToken: string,
  outcome:
    | { status: 'succeeded'; result: string }
    | { status: 'failed' | 'cancelled' | 'lost'; error: { code: string; message: string } },
): Promise<SubagentRunRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(subagent_run)
      .where(eq(subagent_run.id, runId))
      .for('update');
    if (!row) throw new Error('subagent run not found');
    if (!['queued', 'running'].includes(row.status)) return mapRun(row);
    if (row.claim_token !== claimToken) throw new Error('subagent claim token mismatch');
    return settleSubagentRunTx(tx, row, outcome);
  });
}

export async function cancelSubagentRun(
  db: Db,
  runId: string,
  sessionId: string,
  requestedBy: CancellationOwner,
): Promise<SubagentRunRecord> {
  return db.transaction(async (tx) => {
    return cancelSubagentRunTx(tx, runId, sessionId, requestedBy);
  });
}

async function cancelSubagentRunTx(
  tx: Tx,
  runId: string,
  sessionId: string,
  requestedBy: CancellationOwner,
): Promise<SubagentRunRecord> {
  const [row] = await tx
    .select()
    .from(subagent_run)
    .where(eq(subagent_run.id, runId))
    .for('update');
  if (!row || row.session_id !== sessionId) throw new Error('subagent run not found');
  if (!['queued', 'running'].includes(row.status)) return mapRun(row);
  const now = new Date();
  const [marked] = await tx
    .update(subagent_run)
    .set({ cancel_requested_by: requestedBy, cancel_requested_at: now, updated_at: now })
    .where(eq(subagent_run.id, runId))
    .returning();
  if (!marked) throw new Error('subagent cancellation failed');
  if (row.status === 'queued') {
    return settleSubagentRunTx(tx, marked, {
      status: 'cancelled',
      error: {
        code: 'cancelled_before_start',
        message: 'Subagent cancelled before provider execution',
      },
    });
  }
  return mapRun(marked);
}

export async function cancelSubagentsForParentTx(
  tx: Tx,
  sessionId: string,
  parentTaskRunId: string,
  requestedBy: CancellationOwner,
): Promise<SubagentRunRecord[]> {
  const rows = await tx
    .select({ id: subagent_run.id })
    .from(subagent_run)
    .where(
      and(
        eq(subagent_run.session_id, sessionId),
        matchesParentTaskRunId(parentTaskRunId),
        inArray(subagent_run.status, ['queued', 'running']),
      ),
    );
  const cancelled: SubagentRunRecord[] = [];
  for (const row of rows) {
    cancelled.push(await cancelSubagentRunTx(tx, row.id, sessionId, requestedBy));
  }
  return cancelled;
}

export async function cancelSubagentsForParent(
  db: Db,
  sessionId: string,
  parentTaskRunId: string,
  requestedBy: CancellationOwner,
): Promise<SubagentRunRecord[]> {
  return db.transaction((tx) =>
    cancelSubagentsForParentTx(tx, sessionId, parentTaskRunId, requestedBy),
  );
}

function nativeLaunchKey(sdkTaskId: string): string {
  const trimmed = sdkTaskId.trim();
  if (trimmed.length < 1 || trimmed.length > NATIVE_SUBAGENT_LAUNCH_KEY_MAX_CHARS) {
    throw new Error(
      `native subagent task_id must be 1..${NATIVE_SUBAGENT_LAUNCH_KEY_MAX_CHARS} characters`,
    );
  }
  return trimmed;
}

export async function recordNativeSubagentStarted(
  db: Db,
  input: {
    sessionId: string;
    parentTurnEventId: string;
    parentTaskRunId: string;
    sdkTaskId: string;
    objective: string;
  },
): Promise<SubagentRunRecord | null> {
  const launchKey = nativeLaunchKey(input.sdkTaskId);
  const objective = input.objective.trim();
  if (objective.length < 1 || objective.length > SUBAGENT_OBJECTIVE_MAX_CHARS) {
    throw new Error(`objective must be 1..${SUBAGENT_OBJECTIVE_MAX_CHARS} characters`);
  }
  const objectiveHash = sha256CanonicalJson({ objective });
  return db.transaction(async (tx) =>
    recordNativeSubagentStartedTx(tx, { ...input, launchKey, objective, objectiveHash }),
  );
}

async function recordNativeSubagentStartedTx(
  tx: Tx,
  input: {
    sessionId: string;
    parentTurnEventId: string;
    parentTaskRunId: string;
    launchKey: string;
    objective: string;
    objectiveHash: string;
  },
): Promise<SubagentRunRecord | null> {
  const [existing] = await tx
    .select()
    .from(subagent_run)
    .where(
      and(
        eq(subagent_run.session_id, input.sessionId),
        eq(subagent_run.parent_turn_event_id, input.parentTurnEventId),
        eq(subagent_run.launch_key, input.launchKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.objective_hash !== input.objectiveHash) {
      throw new Error('launch_key is already bound to different canonical input');
    }
    return mapRun(existing);
  }
  const id = `subagent_run_${createId()}`;
  const startedEventId = `subagent_started_${id}`;
  const now = new Date();
  const [created] = await tx
    .insert(subagent_run)
    .values({
      id,
      session_id: input.sessionId,
      parent_turn_event_id: input.parentTurnEventId,
      launch_key: input.launchKey,
      parent_task_run_id: input.parentTaskRunId,
      objective_hash: input.objectiveHash,
      objective: input.objective,
      status: 'running',
      started_event_id: startedEventId,
      started_at: now,
      created_at: now,
      updated_at: now,
    })
    .returning();
  if (!created) throw new Error('native subagent run insert failed');
  await writeEvent(tx, {
    id: startedEventId,
    session_id: input.sessionId,
    actor_kind: 'agent',
    actor_ref: 'agent:copilot-researcher',
    action: 'experimental:subagent_run_started',
    subject_kind: 'subagent_run',
    subject_id: id,
    outcome: null,
    payload: { run_id: id, launch_key: input.launchKey, objective: input.objective },
    caused_by_event_id: input.parentTurnEventId,
    task_run_id: input.parentTaskRunId,
    ingest_at: now,
    created_at: now,
  });
  return mapRun(created);
}

async function settleNativeSubagentRunTx(
  tx: Tx,
  row: RunRow,
  outcome:
    | { status: 'succeeded'; result: string }
    | { status: 'failed' | 'cancelled' | 'lost'; error: { code: string; message: string } },
): Promise<SubagentRunRecord | null> {
  if (!['queued', 'running'].includes(row.status)) return mapRun(row);
  return settleSubagentRunTx(tx, row, outcome, { mintContinuation: false });
}

export async function settleNativeSubagentRun(
  db: Db,
  input: {
    sessionId: string;
    sdkTaskId: string;
    outcome:
      | { status: 'succeeded'; result: string }
      | { status: 'failed' | 'cancelled' | 'lost'; error: { code: string; message: string } };
  },
): Promise<SubagentRunRecord | null> {
  const launchKey = nativeLaunchKey(input.sdkTaskId);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(subagent_run)
      .where(
        and(eq(subagent_run.session_id, input.sessionId), eq(subagent_run.launch_key, launchKey)),
      )
      .for('update');
    if (!row) return null;
    return settleNativeSubagentRunTx(tx, row, input.outcome);
  });
}

function terminalNativeSubagentOutcome(
  message: CopilotTaskLifecycleMessage,
):
  | { status: 'succeeded'; result: string }
  | { status: 'failed' | 'cancelled' | 'lost'; error: { code: string; message: string } }
  | null {
  if (message.subtype === 'task_notification') {
    if (message.status === 'completed') {
      return { status: 'succeeded', result: 'Native Task child completed.' };
    }
    return {
      status: 'failed',
      error: { code: 'native_task_failed', message: 'Native Task child did not complete.' },
    };
  }
  if (message.subtype === 'task_updated') {
    if (message.patch.status === 'completed') {
      return { status: 'succeeded', result: 'Native Task child completed.' };
    }
    if (message.patch.status === 'failed' || message.patch.status === 'killed') {
      return {
        status: 'failed',
        error: { code: 'native_task_failed', message: 'Native Task child did not complete.' },
      };
    }
  }
  return null;
}

/** Project native SDK Task lifecycle into subagent_run without mailbox continuation. */
export async function handleNativeSubagentTaskEvent(
  db: Db,
  message: CopilotTaskLifecycleMessage,
  ctx: {
    sessionId: string;
    parentTurnEventId: string;
    parentTaskRunId: string;
  },
): Promise<void> {
  if (message.subtype === 'task_started') {
    if (
      message.subagent_type !== COPILOT_SUBAGENT_NAME ||
      message.task_type === 'local_workflow' ||
      message.skip_transcript === true
    ) {
      return;
    }
    const objective = message.description?.trim() || 'Copilot researcher task';
    await recordNativeSubagentStarted(db, {
      sessionId: ctx.sessionId,
      parentTurnEventId: ctx.parentTurnEventId,
      parentTaskRunId: ctx.parentTaskRunId,
      sdkTaskId: message.task_id,
      objective,
    });
    return;
  }

  const outcome = terminalNativeSubagentOutcome(message);
  if (!outcome) return;
  await settleNativeSubagentRun(db, {
    sessionId: ctx.sessionId,
    sdkTaskId: message.task_id,
    outcome,
  });
}

export function bindSubagentParentCancellation(
  db: Db,
  input: {
    sessionId: string;
    parentTaskRunId: string;
    signals: ReadonlyArray<{
      signal: AbortSignal;
      requestedBy: Exclude<CancellationOwner, 'model'>;
    }>;
  },
): () => Promise<void> {
  let disposed = false;
  let cancellation: Promise<void> | undefined;
  const listeners = input.signals.map(({ signal, requestedBy }) => {
    const cancel = () => {
      if (disposed || cancellation) return;
      cancellation = cancelSubagentsForParent(
        db,
        input.sessionId,
        input.parentTaskRunId,
        requestedBy,
      ).then(
        () => undefined,
        (error) => {
          console.error('[copilot_subagent] parent cancellation failed', {
            parentTaskRunId: input.parentTaskRunId,
            error,
          });
        },
      );
    };
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    return { signal, cancel };
  });
  return async () => {
    disposed = true;
    for (const { signal, cancel } of listeners) signal.removeEventListener('abort', cancel);
    await cancellation;
  };
}

export async function recoverSubagentMailbox(
  db: Db,
  options: {
    beforeRecoverExpiredRun?: (record: SubagentRunRecord) => Promise<void>;
  } = {},
): Promise<{
  queuedRunIds: string[];
  lostRunIds: string[];
  pendingContinuationIds: string[];
}> {
  const now = new Date();
  const rows = await db
    .select()
    .from(subagent_run)
    .where(
      or(
        eq(subagent_run.status, 'queued'),
        and(eq(subagent_run.status, 'running'), lt(subagent_run.lease_expires_at, now)),
      ),
    );
  const queuedRunIds: string[] = [];
  const lostRunIds: string[] = [];
  for (const row of rows) {
    if (row.status === 'queued') queuedRunIds.push(row.id);
    else {
      await options.beforeRecoverExpiredRun?.(mapRun(row));
      const lost = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(subagent_run)
          .where(eq(subagent_run.id, row.id))
          .for('update');
        if (
          current?.status !== 'running' ||
          current.claim_token !== row.claim_token ||
          !current.lease_expires_at ||
          current.lease_expires_at.getTime() >= now.getTime()
        ) {
          return false;
        }
        await settleSubagentRunTx(tx, current, {
          status: 'lost',
          error: {
            code: 'lease_expired_after_provider_fence',
            message: 'Subagent ownership expired after provider execution began',
          },
        });
        return true;
      });
      if (lost) lostRunIds.push(row.id);
    }
  }
  const pending = await db
    .select({ id: copilot_continuation.id })
    .from(copilot_continuation)
    .where(
      or(
        eq(copilot_continuation.status, 'pending'),
        and(
          eq(copilot_continuation.status, 'running'),
          lt(copilot_continuation.lease_expires_at, now),
        ),
      ),
    );
  return { queuedRunIds, lostRunIds, pendingContinuationIds: pending.map((row) => row.id) };
}

function mapContinuation(row: typeof copilot_continuation.$inferSelect): CopilotContinuationRecord {
  return {
    id: row.id,
    subagentRunId: row.subagent_run_id,
    sessionId: row.session_id,
    parentTurnEventId: row.parent_turn_event_id,
    resultEventId: row.result_event_id,
    status: row.status as ContinuationStatus,
    taskRunId: row.task_run_id,
    replyEventId: row.reply_event_id,
  };
}

export async function claimCopilotContinuation(
  db: Db,
  continuationId: string,
): Promise<
  | { record: CopilotContinuationRecord; claimToken: string; child: SubagentRunRecord }
  | { waiting: true }
  | { lost: CopilotContinuationRecord }
  | null
> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .select()
      .from(copilot_continuation)
      .where(eq(copilot_continuation.id, continuationId))
      .for('update');
    if (!row || !['pending', 'running'].includes(row.status)) return null;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`copilot-continuation:${row.session_id}`}, 0))`,
    );
    if (row.status === 'running') {
      if (row.lease_expires_at && row.lease_expires_at.getTime() > now.getTime()) {
        return { waiting: true };
      }
      const [lost] = await tx
        .update(copilot_continuation)
        .set({
          status: 'lost',
          error_code: 'provider_fence_reclaimed',
          error_message: 'Continuation ownership ended after provider execution began',
          settled_at: now,
          lease_expires_at: null,
          updated_at: now,
        })
        .where(eq(copilot_continuation.id, continuationId))
        .returning();
      return lost ? { lost: mapContinuation(lost) } : null;
    }
    const [childRow] = await tx
      .select()
      .from(subagent_run)
      .where(eq(subagent_run.id, row.subagent_run_id))
      .for('update')
      .limit(1);
    if (!childRow) throw new Error('continuation child not found');
    if (childRow.status === 'cancelled') {
      const [skipped] = await tx
        .update(copilot_continuation)
        .set({ status: 'skipped', settled_at: now, updated_at: now })
        .where(eq(copilot_continuation.id, row.id))
        .returning();
      return skipped ? { lost: mapContinuation(skipped) } : null;
    }
    const [parentReply] = await tx
      .select({ id: event.id, outcome: event.outcome, payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.session_id, row.session_id),
          eq(event.action, 'experimental:copilot_reply'),
          eq(event.caused_by_event_id, row.parent_turn_event_id),
        ),
      )
      .limit(1);
    const parentFailurePayload =
      parentReply?.payload !== null &&
      typeof parentReply?.payload === 'object' &&
      !Array.isArray(parentReply.payload)
        ? (parentReply.payload as Record<string, unknown>).durable_failure
        : undefined;
    const parentWasCancelled =
      parentReply?.outcome === 'failure' &&
      parentFailurePayload !== null &&
      typeof parentFailurePayload === 'object' &&
      !Array.isArray(parentFailurePayload) &&
      (parentFailurePayload as Record<string, unknown>).reason === 'cancelled';
    if (parentWasCancelled) {
      const [skipped] = await tx
        .update(copilot_continuation)
        .set({ status: 'skipped', settled_at: now, updated_at: now })
        .where(eq(copilot_continuation.id, row.id))
        .returning();
      return skipped ? { lost: mapContinuation(skipped) } : null;
    }
    // A root can terminally fail before it writes a reply event. The parent task
    // run is audit linkage only, never continuation identity; its already-owned
    // lifecycle row is nevertheless the authoritative proof that waiting for a
    // reply can no longer make progress. Do not infer this from timestamps.
    const [parentFailure] = childRow.parent_task_run_id
      ? await tx
          .select({ id: ai_task_runs.id })
          .from(ai_task_runs)
          .where(
            and(
              eq(ai_task_runs.id, childRow.parent_task_run_id),
              eq(ai_task_runs.status, 'failure'),
            ),
          )
          .limit(1)
      : [];
    if (!parentReply && !parentFailure) return { waiting: true };
    const [otherRunning] = await tx
      .select({ id: copilot_continuation.id })
      .from(copilot_continuation)
      .where(
        and(
          eq(copilot_continuation.session_id, row.session_id),
          eq(copilot_continuation.status, 'running'),
        ),
      )
      .limit(1);
    if (otherRunning) return { waiting: true };
    const claimToken = randomUUID();
    const taskRunId = `copilot_continuation_task_${row.id}`;
    const [claimed] = await tx
      .update(copilot_continuation)
      .set({
        status: 'running',
        claim_token: claimToken,
        lease_expires_at: new Date(now.getTime() + SUBAGENT_HARD_DEADLINE_MS),
        task_run_id: taskRunId,
        started_at: now,
        updated_at: now,
      })
      .where(eq(copilot_continuation.id, row.id))
      .returning();
    if (!claimed) return null;
    return { record: mapContinuation(claimed), claimToken, child: mapRun(childRow) };
  });
}

export async function settleCopilotContinuation(
  db: DbLike,
  input: {
    continuationId: string;
    claimToken: string;
    status: 'succeeded' | 'failed' | 'cancelled' | 'lost';
    replyEventId?: string | null;
    error?: { code: string; message: string };
  },
): Promise<CopilotContinuationRecord> {
  const [row] = await db
    .update(copilot_continuation)
    .set({
      status: input.status,
      reply_event_id: input.replyEventId ?? null,
      error_code: input.error?.code ?? null,
      error_message: input.error?.message ?? null,
      settled_at: new Date(),
      lease_expires_at: null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(copilot_continuation.id, input.continuationId),
        eq(copilot_continuation.status, 'running'),
        eq(copilot_continuation.claim_token, input.claimToken),
      ),
    )
    .returning();
  if (row) return mapContinuation(row);
  const [existing] = await db
    .select()
    .from(copilot_continuation)
    .where(eq(copilot_continuation.id, input.continuationId))
    .limit(1);
  if (!existing) throw new Error('copilot continuation not found');
  return mapContinuation(existing);
}
