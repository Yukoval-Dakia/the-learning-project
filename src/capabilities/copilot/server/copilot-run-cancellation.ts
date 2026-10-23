import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { PiBeforeToolCall } from '@/core/tool-call-contract';
import type { Db, Tx } from '@/db/client';
import { event, job_events, tool_operation } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { writeJobEvent } from '@/server/events/writer';
import { writeCopilotReply } from './conversation-writes';
import { acquireCopilotExecutionSettlementLock } from './copilot-run-coordination';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  hasCancelRequest,
  isCopilotRunTerminalEvent,
} from './copilot-run-status';
import {
  readCopilotDurableAcceptanceByRunId,
  withCopilotDurableDispatchLock,
} from './durable-dispatch';
import { MATERIALIZING_TOOL_NAMES } from './materializing-tools';
import type { CopilotReplyFinalizationReceipt, PreparedCopilotReply } from './reply-finalization';
import { cancelSubagentsForParentTx } from './subagent-mailbox';

export const COPILOT_CANCEL_POLL_INTERVAL_MS = 500;
export const COPILOT_CANCEL_DRAIN_GRACE_MS = 30_000;
export const COPILOT_STOPPED_REPLY = '已停止这次运行。';
const COPILOT_UNFINISHED_NOTE = '上面是已经拿到的结果，结论还没写完。';

/** Prose and completed tool summaries plus the unfinished note; undefined when both are empty. */
export function copilotPartialReply(input: {
  prose?: string;
  toolSummaries?: readonly string[];
}): string | undefined {
  const prose = input.prose?.trim() ?? '';
  const lines = (input.toolSummaries ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const body = [prose, lines.join('\n')].filter((part) => part.length > 0).join('\n\n');
  if (body.length === 0) return undefined;
  return `${body}\n\n${COPILOT_UNFINISHED_NOTE}`;
}

export type CopilotCancellationProbeResult = 'clear' | 'cancel_requested' | 'unknown';

export interface PersistCopilotRunCancellationArgs {
  runId: string;
  sessionId: string;
  actorRef: string;
  partialText?: string;
  toolSummaries?: readonly string[];
  /** Actual provider run when stream collection reached a terminal result. */
  taskRunId?: string;
  preparedReply?: PreparedCopilotReply;
  replyFinalization?: CopilotReplyFinalizationReceipt;
  checkpointSafe: boolean;
  writeCopilotReplyFn?: typeof writeCopilotReply;
}

export interface PersistedCopilotRunCancellation {
  outcome: 'failure';
  replyMd: string;
  taskRunId: string;
  reason: 'cancelled';
  error: string;
  checkpointSafe?: boolean;
}

/**
 * Persist the one domain reply that closes a cancelled user ask. Both a
 * pre-fence API Stop and an in-loop worker Stop use this shape so conversation
 * history never contains a phantom, unanswered ask.
 */
export async function persistCopilotRunCancellationMarker(
  tx: Tx,
  args: PersistCopilotRunCancellationArgs,
): Promise<PersistedCopilotRunCancellation> {
  const replyText =
    args.partialText !== undefined && args.preparedReply?.text === args.partialText
      ? args.partialText
      : (copilotPartialReply({
          prose: args.partialText,
          toolSummaries: args.toolSummaries,
        }) ?? COPILOT_STOPPED_REPLY);
  const error = 'copilot run cancelled by user';
  const taskRunId = args.taskRunId ?? `copilot_run_cancelled_${args.runId}`;
  const writeReply = args.writeCopilotReplyFn ?? writeCopilotReply;
  const { cleanedReply } = await writeReply(tx, {
    sessionId: args.sessionId,
    userAskEventId: args.runId,
    replyText,
    ...(args.preparedReply ? { preparedReply: args.preparedReply } : {}),
    actorRef: args.actorRef,
    taskRunId,
    ...(args.replyFinalization ? { replyFinalization: args.replyFinalization } : {}),
    outcome: 'failure',
    durableFailure: {
      reason: 'cancelled',
      error,
      ...(args.checkpointSafe ? {} : { checkpoint_safe: false }),
    },
    now: new Date(),
  });
  return {
    outcome: 'failure',
    replyMd: cleanedReply,
    taskRunId,
    reason: 'cancelled',
    error,
    ...(args.checkpointSafe ? {} : { checkpointSafe: false }),
  };
}

export interface CopilotRunCancellationControl {
  readonly signal: AbortSignal;
  readonly hasConfirmedCancellation: boolean;
  readonly materializingToolStarted: boolean;
  startPolling(): void;
  dispose(): void;
  probe(): Promise<CopilotCancellationProbeResult>;
  beforeTool(): Promise<string | undefined>;
  /**
   * The pi `beforeToolCall` gate: abort-signal short-circuit → probe → deny
   * reason. `beforeTool()` remains the DomainTool-side gate.
   */
  piBeforeToolCall: PiBeforeToolCall;
  onToolExecutionStarted(tool: { name: string }): void;
  onToolExecutionSettled(): void;
  waitForInFlight(graceMs?: number): Promise<boolean>;
}

const CANCELLED_TOOL_REASON = 'cancel requested; do not start another tool';
const UNKNOWN_TOOL_REASON = 'cancel state is temporarily unavailable; tool execution paused';

async function readCancelRequest(db: Db, runId: string): Promise<boolean> {
  const rows = await db
    .select({ id: job_events.id })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, COPILOT_RUN_TABLE),
        eq(job_events.business_id, runId),
        eq(job_events.event_type, COPILOT_RUN_EVENTS.CANCEL_REQUESTED),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Bridge the cross-process job-event truth into one caller-owned AbortSignal.
 * Polling and both tool gates share a single non-overlapping probe and a
 * monotonic cancellation latch.
 */
export function createCopilotRunCancellationControl(options: {
  db: Db;
  runId: string;
  pollIntervalMs?: number;
  readCancelRequestFn?: () => Promise<boolean>;
}): CopilotRunCancellationControl {
  const controller = new AbortController();
  const pollIntervalMs = options.pollIntervalMs ?? COPILOT_CANCEL_POLL_INTERVAL_MS;
  const read = options.readCancelRequestFn ?? (() => readCancelRequest(options.db, options.runId));
  let confirmedCancellation = false;
  let materializingToolStarted = false;
  let disposed = false;
  let pollingStarted = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let probeInFlight: Promise<CopilotCancellationProbeResult> | undefined;
  let observationUnavailable = false;
  let inFlightTools = 0;
  const drainWaiters = new Set<() => void>();

  function confirmCancellation(): void {
    if (confirmedCancellation) return;
    confirmedCancellation = true;
    controller.abort(new Error('copilot run cancelled by user'));
  }

  async function probe(): Promise<CopilotCancellationProbeResult> {
    if (confirmedCancellation) return 'cancel_requested';
    if (probeInFlight) return probeInFlight;
    probeInFlight = (async () => {
      try {
        if (await read()) {
          confirmCancellation();
          return 'cancel_requested' as const;
        }
        observationUnavailable = false;
        return 'clear' as const;
      } catch (error) {
        if (!observationUnavailable) {
          console.error('[copilot_run] cancellation observation unavailable', {
            runId: options.runId,
            error,
          });
        }
        observationUnavailable = true;
        return 'unknown' as const;
      } finally {
        probeInFlight = undefined;
      }
    })();
    return probeInFlight;
  }

  function scheduleNextPoll(): void {
    if (disposed || confirmedCancellation) return;
    pollTimer = setTimeout(() => {
      void (async () => {
        await probe();
        scheduleNextPoll();
      })();
    }, pollIntervalMs);
  }

  return {
    signal: controller.signal,
    get hasConfirmedCancellation() {
      return confirmedCancellation;
    },
    get materializingToolStarted() {
      return materializingToolStarted;
    },
    startPolling() {
      if (pollingStarted || disposed) return;
      pollingStarted = true;
      // Probe immediately, then continue on a recursive timer so slow database
      // reads can never pile up.
      void (async () => {
        await probe();
        scheduleNextPoll();
      })();
    },
    dispose() {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
    },
    probe,
    async beforeTool() {
      const state = await probe();
      if (state === 'clear') return undefined;
      return state === 'cancel_requested' ? CANCELLED_TOOL_REASON : UNKNOWN_TOOL_REASON;
    },
    piBeforeToolCall: async (_call, _args, signal) => {
      if (signal?.aborted || controller.signal.aborted) {
        return { block: true as const, reason: 'run is stopping; tool execution denied' };
      }
      const state = await probe();
      if (state === 'clear') return undefined;
      return {
        block: true as const,
        reason: state === 'cancel_requested' ? CANCELLED_TOOL_REASON : UNKNOWN_TOOL_REASON,
      };
    },
    onToolExecutionStarted(tool) {
      inFlightTools += 1;
      if (MATERIALIZING_TOOL_NAMES.has(tool.name)) materializingToolStarted = true;
    },
    onToolExecutionSettled() {
      if (inFlightTools > 0) inFlightTools -= 1;
      if (inFlightTools === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    },
    async waitForInFlight(graceMs = COPILOT_CANCEL_DRAIN_GRACE_MS) {
      if (inFlightTools === 0) return true;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          drainWaiters.delete(onDrained);
          resolve(value);
        };
        const onDrained = () => finish(true);
        const timer = setTimeout(() => finish(false), graceMs);
        drainWaiters.add(onDrained);
      });
    },
  };
}

export type CancelCopilotRunStatus =
  | 'cancel_requested'
  | 'cancelled'
  | 'already_requested'
  | 'already_settled';

/** Request cooperative cancellation of one accepted durable Copilot run. */
export async function requestCopilotRunCancellation(
  db: Db,
  runId: string,
  wakeSession?: (sessionId: string) => Promise<unknown>,
): Promise<CancelCopilotRunStatus> {
  const result = await withCopilotDurableDispatchLock(db, runId, async (tx) => {
    // Lock order is always dispatch -> settlement. The worker's paid loop
    // holds neither lock; only its fence and short outcome commit do.
    await acquireCopilotExecutionSettlementLock(tx, runId);

    const acceptance = await readCopilotDurableAcceptanceByRunId(tx, runId);
    if (!acceptance) throw new ApiError('not_found', 'copilot run not found', 404);

    // A QUEUED row alone is not enough: bind the public handle back to the
    // canonical input event and its fixed conversation session.
    const roots = await tx
      .select({ id: event.id, action: event.action })
      .from(event)
      .where(
        and(
          eq(event.id, runId),
          inArray(event.action, [
            'experimental:copilot_user_ask',
            'experimental:copilot_chip_trigger',
          ]),
          eq(event.session_id, acceptance.sessionId),
        ),
      )
      .limit(1);
    if (roots.length === 0) throw new ApiError('not_found', 'copilot run not found', 404);
    const typedAsk = roots[0]?.action === 'experimental:copilot_user_ask';

    const events = await tx
      .select({
        id: job_events.id,
        event_type: job_events.event_type,
        payload: job_events.payload,
      })
      .from(job_events)
      .where(
        and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
      )
      .orderBy(asc(job_events.id));

    const toolTaskRunId = `copilot_run_tool_${runId}`;
    const runningOwnedOperations = await tx
      .select({ id: tool_operation.id })
      .from(tool_operation)
      .where(
        and(
          eq(tool_operation.session_id, acceptance.sessionId),
          eq(tool_operation.status, 'running'),
          or(
            eq(tool_operation.task_run_id, toolTaskRunId),
            and(
              sql`left(${tool_operation.task_run_id}, char_length(${toolTaskRunId})) = ${toolTaskRunId}`,
              sql`substring(${tool_operation.task_run_id} from char_length(${toolTaskRunId}) + 1) ~ '^_retry_[1-9][0-9]*$'`,
            ),
          ),
        ),
      )
      .limit(1);
    const hasRunningOwnedOperation = runningOwnedOperations.length > 0;

    if (events.some(isCopilotRunTerminalEvent) && !hasRunningOwnedOperation) {
      return { status: 'already_settled' as const, sessionId: acceptance.sessionId };
    }

    // The domain outcome is authoritative even when its public DONE/FAILED
    // suffix has not yet been projected.
    const markers = await tx
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:copilot_reply'),
          eq(event.caused_by_event_id, runId),
          inArray(event.outcome, ['success', 'failure']),
        ),
      )
      .limit(1);
    if (markers.length > 0 && !hasRunningOwnedOperation) {
      return { status: 'already_settled' as const, sessionId: acceptance.sessionId };
    }

    const executionStarted = events.some(
      (item) => item.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED,
    );
    const queued = events.find((item) => item.event_type === COPILOT_RUN_EVENTS.QUEUED);
    const actorRef =
      queued?.payload.triggered_by === 'chip' ? 'agent:copilot_chip' : 'agent:copilot';
    if (hasCancelRequest(events)) {
      // A pre-fence orphan request can only come from legacy/manual data: a
      // normal endpoint call writes request + terminal in this transaction.
      if (!executionStarted) {
        await persistCopilotRunCancellationMarker(tx, {
          runId,
          sessionId: acceptance.sessionId,
          actorRef,
          checkpointSafe: typedAsk,
        });
        await writeJobEvent(tx, {
          business_table: COPILOT_RUN_TABLE,
          business_id: runId,
          event_type: COPILOT_RUN_EVENTS.FAILED,
          payload: {
            reason: 'cancelled',
            cancelled_before_start: true,
            ...(typedAsk ? { checkpoint_event_id: runId } : {}),
          },
        });
        return { status: 'cancelled' as const, sessionId: acceptance.sessionId };
      }
      return { status: 'already_requested' as const, sessionId: acceptance.sessionId };
    }

    await writeJobEvent(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
      payload: { requested_by: 'user', requested_at: new Date().toISOString() },
    });
    await cancelSubagentsForParentTx(tx, acceptance.sessionId, toolTaskRunId, 'user');

    if (executionStarted || hasRunningOwnedOperation) {
      return { status: 'cancel_requested' as const, sessionId: acceptance.sessionId };
    }

    // The shared dispatch lock makes this atomic with the paid-execution
    // fence: once this commits, the worker cannot enter model/tool execution.
    await persistCopilotRunCancellationMarker(tx, {
      runId,
      sessionId: acceptance.sessionId,
      actorRef,
      checkpointSafe: typedAsk,
    });
    await writeJobEvent(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.FAILED,
      payload: {
        reason: 'cancelled',
        cancelled_before_start: true,
        ...(typedAsk ? { checkpoint_event_id: runId } : {}),
      },
    });
    return { status: 'cancelled' as const, sessionId: acceptance.sessionId };
  });

  if (wakeSession && (result.status === 'cancelled' || result.status === 'already_settled')) {
    // Cancellation/terminalization is already committed. A wake failure must
    // not turn a successful Stop into a false failure; the reconciler retries.
    await wakeSession(result.sessionId).catch((error) => {
      console.error('[copilot/cancel-run] failed to dispatch next session head', {
        session_id: result.sessionId,
        run_id: runId,
        error,
      });
    });
  }

  return result.status;
}
