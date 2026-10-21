// Durable copilot run settlement & recovery owner.
//
// One module owns every write that can terminalize an accepted run: the two-gate
// pre-execution protocol under the dispatch lock, the settlement lock shared by
// paid-owner outcome, API Stop and recovery, and the outcome-marker two-phase
// (domain reply first, public REPLY/DONE or FAILED projection second) so a
// projection failure is repairable without re-running paid work. Live progress
// publishes only while no cancel request and no committed outcome marker exist.
//
// The execution owner feeds its final outcome in here; it never appends terminal
// job_events itself.

import { and, asc, eq } from 'drizzle-orm';
import { isDurableWorkerTouchEvent } from '@/capabilities/copilot/durable-pickup';
import type {
  CopilotModeState,
  CopilotSkillTurn,
} from '@/capabilities/copilot/server/chat-contracts';
import type { PreparedCopilotReply } from '@/capabilities/copilot/server/conversation-writes';
import { writeCopilotReply } from '@/capabilities/copilot/server/conversation-writes';
import { DURABLE_COPILOT_EXECUTION_BUDGET } from '@/capabilities/copilot/server/copilot-execution';
import {
  type PersistCopilotRunCancellationArgs,
  persistCopilotRunCancellationMarker,
} from '@/capabilities/copilot/server/copilot-run-cancellation';
import { acquireCopilotExecutionSettlementLock } from '@/capabilities/copilot/server/copilot-run-coordination';
import { selectActorRef } from '@/capabilities/copilot/server/copilot-run-input';
import {
  type PersistedDurableReply,
  findPersistedDurableReply,
} from '@/capabilities/copilot/server/copilot-run-outcome';
import { discardRunWorkerSessionCursor } from '@/capabilities/copilot/server/copilot-run-session-cursor';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  hasCancelRequest,
  isCopilotRunTerminalEvent,
} from '@/capabilities/copilot/server/copilot-run-status';
import {
  type CopilotRunJobData,
  withCopilotDurableDispatchLock,
} from '@/capabilities/copilot/server/durable-dispatch';
import { selectAsksWithMaterializingToolCall } from '@/capabilities/copilot/server/materializing-tools';
import { parseCopilotModeState } from '@/capabilities/copilot/server/mode-completion';
import {
  CopilotPrimaryViewSchema,
  type CopilotReplyFinalizationReceipt,
} from '@/capabilities/copilot/server/reply-finalization';
import type { CopilotPrimaryView } from '@/capabilities/copilot/server/turns';
import type { Db, Tx } from '@/db/client';
import { event, job_events } from '@/db/schema';
import {
  type BossJobObservation,
  type BossJobObserver,
  observeBossJob,
} from '@/server/boss/job-observation';
import { writeJobEvent } from '@/server/events/writer';

export const COPILOT_RUN_QUEUE = 'copilot_run' as const;

export type RunCopilotRunResult =
  | {
      status: 'done';
      reply: string;
      task_run_id: string;
      skill_turn?: CopilotSkillTurn;
      primary_view?: CopilotPrimaryView;
    }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string };

interface SuccessfulTerminalProjection {
  runId: string;
  replyMd: string;
  taskRunId: string;
  finishReason: string;
  modeState?: CopilotModeState;
  primaryView?: CopilotPrimaryView;
}

export interface TerminalProjectionEvent {
  id?: number;
  event_type: string;
  payload?: Record<string, unknown>;
  occurred_at?: Date;
}

interface FailedTerminalProjection {
  runId: string;
  error: string;
  reason: 'cancelled' | 'exhausted' | 'ambiguous_execution' | 'pre_execution_lost';
  /** Explicit fail-closed override when a materializing tool began before Stop. */
  checkpointSafe?: boolean;
  /** User-facing terminal copy for the live job-events consumer. */
  replyMd?: string;
}

type WriteJobEventFn = (tx: Db | Tx, input: Parameters<typeof writeJobEvent>[1]) => Promise<number>;

type ClaimCopilotExecutionFenceResult =
  | { outcome: 'claimed' }
  | { outcome: 'existing' }
  | { outcome: 'cancelled' }
  | { outcome: 'terminal'; events: TerminalProjectionEvent[] };

export type ClaimCopilotExecutionFenceFn = (
  db: Db,
  runId: string,
  options?: {
    beforeCancelled?: (tx: Tx) => Promise<void>;
    beforeExecution?: (tx: Tx) => Promise<void>;
  },
) => Promise<ClaimCopilotExecutionFenceResult>;

type MarkCopilotRunStartedResult =
  | { outcome: 'started' }
  | { outcome: 'cancelled' }
  | { outcome: 'terminal'; events: TerminalProjectionEvent[] };

/** Prevent a late worker pickup from appending STARTED behind a Stop terminal. */
export async function markCopilotRunStarted(
  db: Db,
  runId: string,
  payload: Record<string, unknown>,
  options: { writeJobEventFn?: WriteJobEventFn; beforeCancelled?: (tx: Tx) => Promise<void> } = {},
): Promise<MarkCopilotRunStartedResult> {
  const write = options.writeJobEventFn ?? writeJobEvent;
  return withCopilotDurableDispatchLock(db, runId, async (tx) => {
    const events = await tx
      .select({ id: job_events.id, event_type: job_events.event_type, payload: job_events.payload })
      .from(job_events)
      .where(
        and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
      )
      .orderBy(asc(job_events.id));
    if (hasCopilotSettlementTerminal(events)) return { outcome: 'terminal', events };
    if (hasCancelRequest(events)) {
      await persistPreExecutionCancellation(tx, runId);
      await options.beforeCancelled?.(tx);
      await write(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.FAILED,
        payload: {
          reason: 'cancelled',
          cancelled_before_start: true,
          ...(await durableCheckpointPayload(tx, runId)),
        },
      });
      return { outcome: 'cancelled' };
    }
    if (!events.some((event) => event.event_type === COPILOT_RUN_EVENTS.STARTED)) {
      await write(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.STARTED,
        payload,
      });
    }
    return { outcome: 'started' };
  });
}

/**
 * Atomically claim the one paid/tool execution allowed for a run. The dispatch
 * advisory lock is shared with API enqueue-failure compensation, so a worker
 * cannot pass a stale replay, let enqueue_failed commit, then start paid work.
 * It also serializes overlapping deliveries before appending the fence.
 */
export async function claimCopilotExecutionFence(
  db: Db,
  runId: string,
  options: {
    writeJobEventFn?: WriteJobEventFn;
    beforeCancelled?: (tx: Tx) => Promise<void>;
    beforeExecution?: (tx: Tx) => Promise<void>;
  } = {},
): Promise<ClaimCopilotExecutionFenceResult> {
  const write = options.writeJobEventFn ?? writeJobEvent;
  return withCopilotDurableDispatchLock(db, runId, async (tx) => {
    const events = await tx
      .select({ id: job_events.id, event_type: job_events.event_type, payload: job_events.payload })
      .from(job_events)
      .where(
        and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
      )
      .orderBy(asc(job_events.id));
    if (hasCopilotSettlementTerminal(events)) return { outcome: 'terminal', events };
    if (events.some((event) => event.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED)) {
      return { outcome: 'existing' };
    }
    if (hasCancelRequest(events)) {
      await persistPreExecutionCancellation(tx, runId);
      await options.beforeCancelled?.(tx);
      await write(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.FAILED,
        payload: {
          reason: 'cancelled',
          cancelled_before_start: true,
          ...(await durableCheckpointPayload(tx, runId)),
        },
      });
      return { outcome: 'cancelled' };
    }
    await options.beforeExecution?.(tx);
    await write(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      payload: { execution_fence: 'at_most_once' },
    });
    return { outcome: 'claimed' };
  });
}

async function persistPreExecutionCancellation(tx: Tx, runId: string): Promise<void> {
  await acquireCopilotExecutionSettlementLock(tx, runId);
  const [ask] = await tx
    .select({ sessionId: event.session_id, action: event.action })
    .from(event)
    .where(eq(event.id, runId))
    .limit(1);
  if (
    !ask?.sessionId ||
    !['experimental:copilot_user_ask', 'experimental:copilot_chip_trigger'].includes(ask.action)
  )
    return;
  if (await findPersistedDurableReply(tx, runId)) return;
  await persistCopilotRunCancellationMarker(tx, {
    runId,
    sessionId: ask.sessionId,
    actorRef:
      ask.action === 'experimental:copilot_chip_trigger' ? 'agent:copilot_chip' : 'agent:copilot',
    checkpointSafe: ask.action === 'experimental:copilot_user_ask',
  });
}

export type WriteSuccessfulTerminalProjectionFn = (
  db: Db | Tx,
  projection: SuccessfulTerminalProjection,
  priorEvents: TerminalProjectionEvent[],
) => Promise<void>;

export type WriteFailedTerminalProjectionFn = (
  db: Db | Tx,
  projection: FailedTerminalProjection,
  priorEvents: TerminalProjectionEvent[],
) => Promise<void>;

export class DurableTerminalProjectionError extends Error {
  constructor(runId: string, outcome: 'success' | 'failure', cause: unknown) {
    super(`durable ${outcome} terminal projection failed for ${runId}`, { cause });
    this.name = 'DurableTerminalProjectionError';
  }
}

function isRootDb(database: Db | Tx): database is Db {
  return '$client' in database;
}

async function withinExistingOrNewTransaction<T>(
  database: Db | Tx,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  return isRootDb(database) ? database.transaction(run) : run(database);
}

/**
 * Revert-anchor policy shared by live output and repair: only an ask-only turn with
 * no materializing tool call gets `checkpoint_event_id`; a failed probe suppresses
 * the anchor instead of guessing.
 */
async function durableCheckpointPayload(
  db: Db | Tx,
  runId: string,
): Promise<Record<string, string>> {
  let turnMaterialized: boolean;
  try {
    const [root] = await db
      .select({ action: event.action })
      .from(event)
      .where(eq(event.id, runId))
      .limit(1);
    if (root?.action !== 'experimental:copilot_user_ask') return {};
    turnMaterialized = (await selectAsksWithMaterializingToolCall(db, [runId])).has(runId);
  } catch (probeErr) {
    console.error('[copilot_run] materializing-tool probe failed; suppressing revert anchor', {
      runId,
      error: probeErr,
    });
    turnMaterialized = true;
  }
  return turnMaterialized ? {} : { checkpoint_event_id: runId };
}

/**
 * Project a persisted successful domain reply into the public job-event stream.
 * REPLY + DONE commit in one transaction, so clients/backlog never observe a
 * permanently half-written success. Existing rows are honoured so a pg-boss
 * redelivery repairs only the missing suffix.
 */
export async function writeSuccessfulTerminalProjection(
  db: Db | Tx,
  projection: SuccessfulTerminalProjection,
  priorEvents: TerminalProjectionEvent[],
  options: { writeJobEventFn?: WriteJobEventFn } = {},
): Promise<void> {
  const write = options.writeJobEventFn ?? writeJobEvent;
  const existingTypes = new Set(priorEvents.map((item) => item.event_type));
  if (existingTypes.has(COPILOT_RUN_EVENTS.DONE)) return;

  // A teaching_check row is not compensated by event-chain revert. The same
  // persisted skill projection suppresses the anchor on live output and repair.
  const checkpointPayload = projection.modeState?.skill_turn.structured_question
    ? {}
    : await durableCheckpointPayload(db, projection.runId);

  await withinExistingOrNewTransaction(db, async (tx) => {
    if (!existingTypes.has(COPILOT_RUN_EVENTS.REPLY)) {
      await write(tx, {
        business_table: COPILOT_RUN_TABLE,
        business_id: projection.runId,
        event_type: COPILOT_RUN_EVENTS.REPLY,
        payload: {
          reply_md: projection.replyMd,
          task_run_id: projection.taskRunId,
          ...(projection.primaryView ? { primary_view: projection.primaryView } : {}),
          ...(projection.modeState ?? {}),
          ...checkpointPayload,
        },
      });
    }
    await write(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: projection.runId,
      event_type: COPILOT_RUN_EVENTS.DONE,
      payload: {
        task_run_id: projection.taskRunId,
        finish_reason: projection.finishReason,
        ...(projection.modeState ?? {}),
        ...checkpointPayload,
      },
    });
  });
}

/** Project a persisted failed domain reply into one load-bearing FAILED frame. */
export async function writeFailedTerminalProjection(
  db: Db | Tx,
  projection: FailedTerminalProjection,
  priorEvents: TerminalProjectionEvent[],
  options: { writeJobEventFn?: WriteJobEventFn } = {},
): Promise<void> {
  // FAILED(reason=error) is a retryable legacy frame, not the outcome of this
  // paid attempt. It must not suppress a new exhausted/ambiguous projection.
  if (
    priorEvents.some(
      (event) => event.event_type === COPILOT_RUN_EVENTS.FAILED && isCopilotRunTerminalEvent(event),
    )
  ) {
    return;
  }
  const write = options.writeJobEventFn ?? writeJobEvent;
  // An execution fence proves the model/tools may have run, not which external
  // effects committed. Missing mirrors during a DB outage cannot make that work
  // safely revertible, so ambiguous recovery never advertises an anchor.
  const checkpointPayload =
    projection.reason === 'ambiguous_execution' || projection.checkpointSafe === false
      ? {}
      : await durableCheckpointPayload(db, projection.runId);
  await withinExistingOrNewTransaction(db, async (tx) => {
    await write(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: projection.runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: projection.reason,
        error: projection.error,
        ...(projection.replyMd ? { reply_md: projection.replyMd } : {}),
        ...checkpointPayload,
      },
    });
  });
}

export const CLAIMED_EXECUTION_SETTLE_GRACE_MS = 30_000;
export const DURABLE_OWNER_SETTLEMENT_BUDGET_MS =
  DURABLE_COPILOT_EXECUTION_BUDGET.timeoutMs + CLAIMED_EXECUTION_SETTLE_GRACE_MS;

export function hasCopilotSettlementTerminal(events: TerminalProjectionEvent[]): boolean {
  return events.some(isCopilotRunTerminalEvent);
}

type CopilotExecutionSettlement<T> =
  | { outcome: 'settled'; value: T }
  | { outcome: 'already_terminal'; events: TerminalProjectionEvent[] };

/** One non-terminal progress frame the execution owner may publish mid-run. */
export type CopilotRunProgressEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'step'; payload: Record<string, unknown> };

/**
 * Publish live progress under the settlement lock. A queued delta/step is
 * dropped once a cancel request or a committed outcome marker exists, so
 * progress can never cross either boundary even when persistence lags the
 * provider. `onDeltaAccepted` fires inside the lock between the boundary check
 * and the event write, so streamed-prose accumulation keeps the write ordering.
 */
export async function publishCopilotRunProgressEvent(
  db: Db,
  runId: string,
  progress: CopilotRunProgressEvent,
  onDeltaAccepted?: (text: string) => void,
): Promise<void> {
  await withCopilotExecutionSettlementLock(db, runId, async (tx, events) => {
    if (hasCancelRequest(events) || (await findPersistedDurableReply(tx, runId))) return;
    if (progress.kind === 'delta') onDeltaAccepted?.(progress.text);
    await writeJobEvent(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: progress.kind === 'delta' ? COPILOT_RUN_EVENTS.DELTA : COPILOT_RUN_EVENTS.STEP,
      payload: progress.kind === 'delta' ? { text: progress.text } : progress.payload,
    });
  });
}

/**
 * Serialize every paid-owner outcome and ambiguous recovery for one run. The
 * expensive model/tool loop deliberately runs outside this lock; recovery may win
 * after the owner deadline, but a late owner then observes that terminal under
 * the same lock and cannot append a contradictory reply/DONE.
 */
export async function withCopilotExecutionSettlementLock<T>(
  db: Db,
  runId: string,
  settle: (tx: Tx, priorEvents: TerminalProjectionEvent[]) => Promise<T>,
): Promise<CopilotExecutionSettlement<T>> {
  return db.transaction(async (tx) => {
    await acquireCopilotExecutionSettlementLock(tx, runId);
    const priorEvents = await tx
      .select({ id: job_events.id, event_type: job_events.event_type, payload: job_events.payload })
      .from(job_events)
      .where(
        and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
      )
      .orderBy(asc(job_events.id));
    // A legacy FAILED(reason=error) is intentionally retryable. It must not
    // discard the successful outcome of that paid retry at settlement time.
    if (hasCopilotSettlementTerminal(priorEvents)) {
      return { outcome: 'already_terminal' as const, events: priorEvents };
    }
    return { outcome: 'settled' as const, value: await settle(tx, priorEvents) };
  });
}

export function terminalRunResult(
  events: TerminalProjectionEvent[],
  fallbackTaskRunId: string,
): RunCopilotRunResult {
  const newestFirst = [...events].reverse();
  const done = newestFirst.find((event) => event.event_type === COPILOT_RUN_EVENTS.DONE);
  if (done) {
    const reply = newestFirst.find((event) => event.event_type === COPILOT_RUN_EVENTS.REPLY);
    const modeState =
      (reply?.payload ? parseCopilotModeState(reply.payload) : undefined) ??
      (done.payload ? parseCopilotModeState(done.payload) : undefined);
    return {
      status: 'done',
      reply: typeof reply?.payload?.reply_md === 'string' ? reply.payload.reply_md : '',
      task_run_id:
        typeof done.payload?.task_run_id === 'string'
          ? done.payload.task_run_id
          : fallbackTaskRunId,
      ...(modeState ? { skill_turn: modeState.skill_turn } : {}),
      ...(reply?.payload
        ? (() => {
            const primaryView = CopilotPrimaryViewSchema.safeParse(reply.payload.primary_view);
            return primaryView.success ? { primary_view: primaryView.data } : {};
          })()
        : {}),
    };
  }
  const failed = newestFirst.find(
    (event) => event.event_type === COPILOT_RUN_EVENTS.FAILED && isCopilotRunTerminalEvent(event),
  );
  const reason = typeof failed?.payload?.reason === 'string' ? failed.payload.reason : 'failed';
  if (reason === 'cancelled') return { status: 'cancelled' };
  return {
    status: 'failed',
    error: typeof failed?.payload?.error === 'string' ? failed.payload.error : reason,
  };
}

type CopilotOutcomeMarkerClaim =
  | { outcome: 'marker'; marker: PersistedDurableReply }
  | { outcome: 'already_terminal'; events: TerminalProjectionEvent[] };

/**
 * Persist the authoritative domain outcome while holding the settlement lock,
 * but commit it before projecting the public suffix. This preserves the known
 * paid result if a later REPLY/DONE/FAILED write fails; redelivery can repair
 * that suffix without re-running model/tools.
 */
export async function ensureCopilotOutcomeMarker(
  db: Db,
  runId: string,
  create: (tx: Tx) => Promise<PersistedDurableReply>,
  options: { createCancelled?: (tx: Tx) => Promise<PersistedDurableReply> } = {},
): Promise<CopilotOutcomeMarkerClaim> {
  const settlement = await withCopilotExecutionSettlementLock(
    db,
    runId,
    async (tx, lockedEvents) => {
      const persisted = await findPersistedDurableReply(tx, runId);
      if (persisted) return persisted;
      if (options.createCancelled && hasCancelRequest(lockedEvents)) {
        return options.createCancelled(tx);
      }
      return create(tx);
    },
  );
  return settlement.outcome === 'settled'
    ? { outcome: 'marker', marker: settlement.value }
    : settlement;
}

/** Re-acquire the same lock and project exactly the marker that actually won. */
export async function projectCopilotOutcomeMarker(
  db: Db,
  runId: string,
  fallbackTaskRunId: string,
  projectSuccessfulTerminal: WriteSuccessfulTerminalProjectionFn,
  projectFailedTerminal: WriteFailedTerminalProjectionFn,
): Promise<RunCopilotRunResult> {
  const settlement = await withCopilotExecutionSettlementLock(
    db,
    runId,
    async (tx, lockedEvents) => {
      const marker = await findPersistedDurableReply(tx, runId);
      if (!marker) throw new Error(`durable outcome marker missing for ${runId}`);
      if (marker.outcome === 'success') {
        await projectSuccessfulTerminal(tx, { runId, ...marker }, lockedEvents);
        return {
          status: 'done' as const,
          reply: marker.replyMd,
          task_run_id: marker.taskRunId,
          ...(marker.modeState ? { skill_turn: marker.modeState.skill_turn } : {}),
          ...(marker.primaryView ? { primary_view: marker.primaryView } : {}),
        };
      }
      if (lockedEvents.some((item) => item.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED)) {
        await discardRunWorkerSessionCursor(tx, runId);
      }
      await projectFailedTerminal(
        tx,
        {
          runId,
          reason: marker.reason,
          error: marker.error,
          replyMd: marker.replyMd,
          checkpointSafe: marker.checkpointSafe,
        },
        lockedEvents,
      );
      return marker.reason === 'cancelled'
        ? ({ status: 'cancelled' } as const)
        : ({ status: 'failed' as const, error: marker.error } as const);
    },
  );
  return settlement.outcome === 'settled'
    ? settlement.value
    : terminalRunResult(settlement.events, fallbackTaskRunId);
}

export async function handleDurableCancellation(
  db: Db,
  args: PersistCopilotRunCancellationArgs & {
    writeCopilotReplyFn: typeof writeCopilotReply;
    projectSuccessfulTerminal: WriteSuccessfulTerminalProjectionFn;
    projectFailedTerminal: WriteFailedTerminalProjectionFn;
  },
): Promise<RunCopilotRunResult> {
  try {
    const markerClaim = await ensureCopilotOutcomeMarker(db, args.runId, (tx) =>
      persistCopilotRunCancellationMarker(tx, args),
    );
    if (markerClaim.outcome === 'already_terminal') {
      return terminalRunResult(markerClaim.events, `copilot_run_tool_${args.runId}`);
    }
    return await projectCopilotOutcomeMarker(
      db,
      args.runId,
      `copilot_run_tool_${args.runId}`,
      args.projectSuccessfulTerminal,
      args.projectFailedTerminal,
    );
  } catch (projectionErr) {
    throw new DurableTerminalProjectionError(args.runId, 'failure', projectionErr);
  }
}

/**
 * Durable failure is deliberate terminal (single-shot): streamTaskCollecting
 * graceful-degrades and never throws AgentRunError, so there is no transient
 * triage. Write the failure marker first (partial text if present, else a focused
 * retry prompt, so the ask never becomes a phantom), then the load-bearing FAILED
 * projection. If projection fails, pg-boss redelivery finds the marker and repairs
 * only FAILED — never re-running model/tools or the conversation reply.
 */
export async function handleDurableFailure(
  db: Db,
  args: {
    err: unknown;
    runId: string;
    sessionId: string;
    actorRef: string;
    /** Real primary provider run when graceful-degrade returned a partial. */
    taskRunId?: string;
    /** streamTaskCollecting graceful-degrade 的半程文本（若有），作 phantom-reply 正文。 */
    partialText?: string;
    /** Byte-authoritative finalized projection for a failed or partial run. */
    preparedReply?: PreparedCopilotReply;
    projectSuccessfulTerminal: WriteSuccessfulTerminalProjectionFn;
    projectFailedTerminal: WriteFailedTerminalProjectionFn;
    writeCopilotReplyFn: typeof writeCopilotReply;
    replyFinalization?: CopilotReplyFinalizationReceipt;
    /** Settlement-lock race winner when Stop committed before this failure marker. */
    createCancelledMarker?: (tx: Tx) => Promise<PersistedDurableReply>;
  },
): Promise<RunCopilotRunResult> {
  const {
    err,
    runId,
    sessionId,
    actorRef,
    taskRunId,
    partialText,
    preparedReply,
    projectSuccessfulTerminal,
    projectFailedTerminal,
    writeCopilotReplyFn,
    replyFinalization,
    createCancelledMarker,
  } = args;
  const message = String((err as Error)?.message ?? err);
  const failureTaskRunId = taskRunId ?? `copilot_run_exhausted_${runId}`;
  const replyText =
    partialText && partialText.length > 0
      ? partialText
      : '这次后台运行没能在预算内收敛完成。可以换个更聚焦的问法再试。';
  try {
    const markerClaim = await ensureCopilotOutcomeMarker(
      db,
      runId,
      async (tx) => {
        const { cleanedReply } = await writeCopilotReplyFn(tx, {
          sessionId,
          userAskEventId: runId,
          replyText,
          ...(preparedReply ? { preparedReply } : {}),
          actorRef,
          taskRunId: failureTaskRunId,
          ...(replyFinalization ? { replyFinalization } : {}),
          outcome: 'failure',
          durableFailure: { reason: 'exhausted', error: message },
          now: new Date(),
        });
        return {
          outcome: 'failure' as const,
          replyMd: cleanedReply,
          taskRunId: failureTaskRunId,
          reason: 'exhausted' as const,
          error: message,
        };
      },
      createCancelledMarker ? { createCancelled: createCancelledMarker } : {},
    );
    if (markerClaim.outcome === 'already_terminal') {
      return terminalRunResult(markerClaim.events, `copilot_run_tool_${runId}`);
    }
    return await projectCopilotOutcomeMarker(
      db,
      runId,
      `copilot_run_tool_${runId}`,
      projectSuccessfulTerminal,
      projectFailedTerminal,
    );
  } catch (projectionErr) {
    throw new DurableTerminalProjectionError(runId, 'failure', projectionErr);
  }
}

/**
 * Recover a redelivery whose paid/external execution may already have happened
 * but whose outcome marker is absent. Exactly-once cannot be reconstructed from
 * that state, so prefer at-most-once execution and tell the user the truth.
 */
export async function handleAmbiguousExecution(
  db: Db,
  args: {
    runId: string;
    sessionId: string;
    actorRef: string;
    projectSuccessfulTerminal: WriteSuccessfulTerminalProjectionFn;
    projectFailedTerminal: WriteFailedTerminalProjectionFn;
    writeCopilotReplyFn: typeof writeCopilotReply;
  },
): Promise<RunCopilotRunResult> {
  const {
    runId,
    sessionId,
    actorRef,
    projectSuccessfulTerminal,
    projectFailedTerminal,
    writeCopilotReplyFn,
  } = args;
  const error = 'execution outcome could not be confirmed after worker recovery';
  const replyText =
    '这次后台运行已经开始，但结果没有可靠保存。为避免重复执行可能已经发生的操作，我没有自动重跑；请先确认现有结果，再决定是否重新发起。';
  try {
    const markerClaim = await ensureCopilotOutcomeMarker(db, runId, async (tx) => {
      await writeCopilotReplyFn(tx, {
        sessionId,
        userAskEventId: runId,
        replyText,
        actorRef,
        taskRunId: `copilot_run_ambiguous_${runId}`,
        outcome: 'failure',
        durableFailure: { reason: 'ambiguous_execution', error },
        now: new Date(),
      });
      return {
        outcome: 'failure' as const,
        replyMd: replyText,
        taskRunId: `copilot_run_ambiguous_${runId}`,
        reason: 'ambiguous_execution' as const,
        error,
      };
    });
    if (markerClaim.outcome === 'already_terminal') {
      return terminalRunResult(markerClaim.events, `copilot_run_tool_${runId}`);
    }
    return await projectCopilotOutcomeMarker(
      db,
      runId,
      `copilot_run_tool_${runId}`,
      projectSuccessfulTerminal,
      projectFailedTerminal,
    );
  } catch (projectionErr) {
    throw new DurableTerminalProjectionError(runId, 'failure', projectionErr);
  }
}

export type CopilotDurableRunObservation =
  | 'settled'
  | 'projection_repaired'
  | 'queued'
  | 'waiting_on_active_run'
  | 'pickup_unavailable'
  | 'retrying'
  | 'running'
  | 'execution_settling'
  | 'pre_execution_lost'
  | 'ambiguous_execution'
  | 'unknown';

export interface ReconcileCopilotDurableRunParams {
  db: Db;
  runId: string;
  sessionId: string;
  triggeredBy: CopilotRunJobData['triggered_by'];
  bossJobId: string;
  pickupDeadlineMs?: number;
  /** One queue snapshot shared by the bounded sweep; used only for presentation. */
  queueActiveCount?: number;
  now?: Date;
  boss?: BossJobObserver;
  writeCopilotReplyFn?: typeof writeCopilotReply;
  writeSuccessfulTerminalProjectionFn?: WriteSuccessfulTerminalProjectionFn;
  writeFailedTerminalProjectionFn?: WriteFailedTerminalProjectionFn;
}

function liveObservation(
  queue: Extract<BossJobObservation, { kind: 'live' }>,
  params: ReconcileCopilotDurableRunParams,
  now: Date,
): 'running' | 'retrying' | 'queued' | 'waiting_on_active_run' | 'pickup_unavailable' | 'unknown' {
  if (queue.state === 'active') return 'running';
  if (queue.state === 'retry') return 'retrying';
  if (params.pickupDeadlineMs === undefined || now.getTime() <= params.pickupDeadlineMs) {
    return 'queued';
  }
  if (params.queueActiveCount === undefined) return 'unknown';
  return params.queueActiveCount > 0 ? 'waiting_on_active_run' : 'pickup_unavailable';
}

type LockedReconcileDecision =
  | { observation: Exclude<CopilotDurableRunObservation, 'projection_repaired'> }
  | { observation: 'marker_found' }
  | { observation: 'ambiguous_candidate' };

/**
 * Converge one accepted durable run without ever invoking model/tools.
 *
 * The dispatch lock makes the pre-execution decision atomic with API enqueue
 * compensation and the worker's paid-execution fence. Once a fence exists,
 * recovery switches to the settlement lock already used by the paid owner; only
 * dead/missing pg-boss evidence and an expired owner budget may produce
 * `ambiguous_execution`. Legacy worker-touch evidence fails closed to that path
 * because retained runs predate the explicit fence.
 */
export async function reconcileCopilotDurableRun(
  params: ReconcileCopilotDurableRunParams,
): Promise<CopilotDurableRunObservation> {
  const {
    db,
    runId,
    sessionId,
    triggeredBy,
    bossJobId,
    boss,
    writeCopilotReplyFn = writeCopilotReply,
    writeSuccessfulTerminalProjectionFn = writeSuccessfulTerminalProjection,
    writeFailedTerminalProjectionFn = writeFailedTerminalProjection,
  } = params;
  const now = params.now ?? new Date();
  const actorRef = selectActorRef(triggeredBy);
  const fallbackTaskRunId = `copilot_run_tool_${runId}`;

  // Cheapest repair first: a paid owner may have committed the domain marker
  // and lost only the public suffix. Re-project it without consulting pg-boss.
  const persisted = await findPersistedDurableReply(db, runId);
  if (persisted) {
    await projectCopilotOutcomeMarker(
      db,
      runId,
      fallbackTaskRunId,
      writeSuccessfulTerminalProjectionFn,
      writeFailedTerminalProjectionFn,
    );
    return 'projection_repaired';
  }

  const locked = await withCopilotDurableDispatchLock<LockedReconcileDecision>(
    db,
    runId,
    async (tx) => {
      const events = await tx
        .select({
          id: job_events.id,
          event_type: job_events.event_type,
          payload: job_events.payload,
          occurred_at: job_events.occurred_at,
        })
        .from(job_events)
        .where(
          and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
        )
        .orderBy(asc(job_events.id));
      if (hasCopilotSettlementTerminal(events)) return { observation: 'settled' };
      // A marker can appear after the optimistic read above. Never overwrite it
      // with delivery-loss copy; project its actual outcome after releasing the lock.
      if (await findPersistedDurableReply(tx, runId)) return { observation: 'marker_found' };

      const queue = await observeBossJob(COPILOT_RUN_QUEUE, bossJobId, {
        ...(boss ? { boss } : {}),
      });
      if (queue.kind === 'unknown') {
        console.error('[copilot_run_reconcile] queue observation unavailable', {
          runId,
          error: queue.error,
        });
        return { observation: 'unknown' };
      }
      if (queue.kind === 'live') {
        return { observation: liveObservation(queue, params, now) };
      }

      // Current deliveries carry an explicit execution fence. Retained legacy
      // runs do not, but STARTED/DELTA/STEP/REPLY/FAILED(error) still prove a
      // worker touched the run and model/tools may have run. Fail closed: only a
      // QUEUED-only history is safe to label pre-execution loss or revertible.
      const explicitFence = events.find(
        (event) => event.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED,
      );
      const possibleExecutionEvidence =
        explicitFence ?? [...events].reverse().find(isDurableWorkerTouchEvent);
      if (possibleExecutionEvidence) {
        const ownerDeadlineMs =
          possibleExecutionEvidence.occurred_at.getTime() + DURABLE_OWNER_SETTLEMENT_BUDGET_MS;
        return now.getTime() > ownerDeadlineMs
          ? { observation: 'ambiguous_candidate' }
          : { observation: 'execution_settling' };
      }

      const error = `pg-boss delivery ${queue.kind === 'missing' ? 'missing' : queue.state} before execution started`;
      const replyText =
        '这次后台运行在开始执行前失去了队列投递，没有调用模型或工具。请重新发送这个请求。';
      const taskRunId = `copilot_run_pre_execution_lost_${runId}`;
      await writeCopilotReplyFn(tx, {
        sessionId,
        userAskEventId: runId,
        replyText,
        actorRef,
        taskRunId,
        outcome: 'failure',
        durableFailure: { reason: 'pre_execution_lost', error },
        now,
      });
      await writeFailedTerminalProjectionFn(
        tx,
        { runId, reason: 'pre_execution_lost', error, replyMd: replyText },
        events,
      );
      return { observation: 'pre_execution_lost' };
    },
  );

  if (locked.observation === 'marker_found') {
    await projectCopilotOutcomeMarker(
      db,
      runId,
      fallbackTaskRunId,
      writeSuccessfulTerminalProjectionFn,
      writeFailedTerminalProjectionFn,
    );
    return 'projection_repaired';
  }
  if (locked.observation !== 'ambiguous_candidate') return locked.observation;

  const result = await handleAmbiguousExecution(db, {
    runId,
    sessionId,
    actorRef,
    projectSuccessfulTerminal: writeSuccessfulTerminalProjectionFn,
    projectFailedTerminal: writeFailedTerminalProjectionFn,
    writeCopilotReplyFn,
  });
  return result.status === 'done' ? 'projection_repaired' : 'ambiguous_execution';
}
