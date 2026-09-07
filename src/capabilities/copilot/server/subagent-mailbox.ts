import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { job_events, subagent_run } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { writeEvent } from '@/kernel/events';
import { acquireCopilotExecutionSettlementLock } from './copilot-run-coordination';
import { findPersistedDurableReply } from './copilot-run-outcome';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  isCopilotRunTerminalEvent,
} from './copilot-run-status';
import { COPILOT_SUBAGENT_NAME, type CopilotTaskLifecycleMessage } from './subagents';
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

type DbLike = Db | Tx;
type RunRow = typeof subagent_run.$inferSelect;

/** Native projections never acquire a mailbox claim or queue delivery. */
export function nativeSubagentProjectionCondition() {
  return and(
    isNotNull(subagent_run.started_at),
    isNull(subagent_run.claim_token),
    isNull(subagent_run.pg_boss_job_id),
    isNull(subagent_run.lease_expires_at),
    isNull(subagent_run.hard_deadline_at),
    isNull(subagent_run.child_task_run_id),
  );
}

type NativeParentClosure = {
  sessionId: string;
  parentTurnEventId: string;
  status: 'cancelled' | 'lost';
};

/** Parent authority is established by the caller; never infer it from a clock. */
async function settleNativeSubagentsForParentTx(tx: Tx, input: NativeParentClosure) {
  await acquireCopilotExecutionSettlementLock(tx, input.parentTurnEventId);
  const rows = await tx
    .select()
    .from(subagent_run)
    .where(
      and(
        eq(subagent_run.session_id, input.sessionId),
        eq(subagent_run.parent_turn_event_id, input.parentTurnEventId),
        eq(subagent_run.status, 'running'),
        nativeSubagentProjectionCondition(),
      ),
    )
    .orderBy(asc(subagent_run.id))
    .for('update');
  for (const row of rows) {
    await settleSubagentRunTx(tx, row, {
      status: input.status,
      error: {
        code: 'native_parent_terminated',
        message: 'Parent execution ended without a native child terminal result.',
      },
    });
  }
  return rows.length;
}

/** Call under the parent's settlement lock; a cancel request alone is not a terminal. */
async function nativeParentTerminal(tx: Tx, sessionId: string, parentTurnEventId: string) {
  const frames = await tx
    .select({ event_type: job_events.event_type, payload: job_events.payload })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, COPILOT_RUN_TABLE),
        eq(job_events.business_id, parentTurnEventId),
      ),
    )
    .orderBy(asc(job_events.id));
  const terminal = frames.findLast(isCopilotRunTerminalEvent);
  if (terminal)
    return terminal.event_type === COPILOT_RUN_EVENTS.FAILED &&
      terminal.payload?.reason === 'cancelled'
      ? ('cancelled' as const)
      : ('lost' as const);
  const marker = await findPersistedDurableReply(tx, parentTurnEventId, sessionId);
  return marker
    ? marker.outcome === 'failure' && marker.reason === 'cancelled'
      ? ('cancelled' as const)
      : ('lost' as const)
    : null;
}

/** Repair only children whose exact parent already has a durable authoritative outcome. */
export async function reconcileNativeSubagentsForParent(
  db: Db,
  sessionId: string,
  parentTurnEventId: string,
) {
  await db.transaction(async (tx) => {
    await acquireCopilotExecutionSettlementLock(tx, parentTurnEventId);
    const status = await nativeParentTerminal(tx, sessionId, parentTurnEventId);
    if (status)
      await settleNativeSubagentsForParentTx(tx, { sessionId, parentTurnEventId, status });
  });
}

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

async function settleSubagentRunTx(
  tx: Tx,
  row: RunRow,
  outcome:
    | { status: 'succeeded'; result: string }
    | { status: 'failed' | 'cancelled' | 'lost'; error: { code: string; message: string } },
): Promise<SubagentRunRecord> {
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
  return mapRun(settled);
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
  await acquireCopilotExecutionSettlementLock(tx, input.parentTurnEventId);
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
  if (await nativeParentTerminal(tx, input.sessionId, input.parentTurnEventId)) return null;
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
    actor_ref: 'agent:copilot',
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
  return settleSubagentRunTx(tx, row, outcome);
}

export async function settleNativeSubagentRun(
  db: Db,
  input: {
    sessionId: string;
    parentTurnEventId: string;
    sdkTaskId: string;
    outcome:
      | { status: 'succeeded'; result: string }
      | { status: 'failed' | 'cancelled' | 'lost'; error: { code: string; message: string } };
  },
): Promise<SubagentRunRecord | null> {
  const launchKey = nativeLaunchKey(input.sdkTaskId);
  return db.transaction(async (tx) => {
    await acquireCopilotExecutionSettlementLock(tx, input.parentTurnEventId);
    const [row] = await tx
      .select()
      .from(subagent_run)
      .where(
        and(
          eq(subagent_run.session_id, input.sessionId),
          eq(subagent_run.parent_turn_event_id, input.parentTurnEventId),
          eq(subagent_run.launch_key, launchKey),
        ),
      )
      .for('update');
    if (!row) return null;
    const parentTerminal = await nativeParentTerminal(tx, input.sessionId, input.parentTurnEventId);
    if (parentTerminal) {
      return settleNativeSubagentRunTx(tx, row, {
        status: parentTerminal,
        error: {
          code: 'native_parent_terminated',
          message: 'Parent execution ended before this child terminal was observed.',
        },
      });
    }
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
): Promise<SubagentRunRecord | null | undefined> {
  if (message.subtype === 'task_started') {
    if (
      message.subagent_type !== COPILOT_SUBAGENT_NAME ||
      message.task_type === 'local_workflow' ||
      message.skip_transcript === true
    ) {
      return;
    }
    const objective = message.description?.trim() || 'Copilot researcher task';
    return recordNativeSubagentStarted(db, {
      sessionId: ctx.sessionId,
      parentTurnEventId: ctx.parentTurnEventId,
      parentTaskRunId: ctx.parentTaskRunId,
      sdkTaskId: message.task_id,
      objective,
    });
  }

  const outcome = terminalNativeSubagentOutcome(message);
  if (!outcome) return;
  return settleNativeSubagentRun(db, {
    sessionId: ctx.sessionId,
    parentTurnEventId: ctx.parentTurnEventId,
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
