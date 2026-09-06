import type { HookCallback, HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk';
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { job_events } from '@/db/schema';
import { writeCopilotReply } from './chat';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import { MATERIALIZING_TOOL_NAMES } from './materializing-tools';
import type { CopilotReplyFinalizationReceipt, PreparedCopilotReply } from './reply-finalization';

export const COPILOT_CANCEL_POLL_INTERVAL_MS = 500;
export const COPILOT_CANCEL_DRAIN_GRACE_MS = 30_000;

export type CopilotCancellationProbeResult = 'clear' | 'cancel_requested' | 'unknown';

export interface PersistCopilotRunCancellationArgs {
  runId: string;
  sessionId: string;
  actorRef: string;
  partialText?: string;
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
 * pre-fence API Stop and an in-loop worker Stop use this shape so future
 * conversation history never contains a phantom, unanswered ask.
 */
export async function persistCopilotRunCancellationMarker(
  tx: Tx,
  args: PersistCopilotRunCancellationArgs,
): Promise<PersistedCopilotRunCancellation> {
  const replyText =
    args.partialText && args.partialText.length > 0 ? args.partialText : '已停止这次运行。';
  const error = 'copilot run cancelled by user';
  const taskRunId = args.taskRunId ?? `copilot_run_cancelled_${args.runId}`;
  const writeReply = args.writeCopilotReplyFn ?? writeCopilotReply;
  const { cleanedReply } = await writeReply(tx, {
    sessionId: args.sessionId,
    userAskEventId: args.runId,
    replyText,
    ...(args.preparedReply?.text === replyText ? { preparedReply: args.preparedReply } : {}),
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
  onToolExecutionStarted(tool: { name: string }): void;
  onToolExecutionSettled(): void;
  waitForInFlight(graceMs?: number): Promise<boolean>;
  prependSdkHook(existing?: Options['hooks']): NonNullable<Options['hooks']>;
}

const CANCELLED_TOOL_REASON = 'cancel requested; do not start another tool';
const UNKNOWN_TOOL_REASON = 'cancel state is temporarily unavailable; tool execution paused';

function denyPreToolUse(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function prependCopilotCancellationHook(
  hook: HookCallback,
  existing?: Options['hooks'],
): NonNullable<Options['hooks']> {
  return {
    ...(existing ?? {}),
    PreToolUse: [{ hooks: [hook] }, ...(existing?.PreToolUse ?? [])],
  };
}

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
 * Polling, SDK hooks and local DomainTool gates share a single non-overlapping
 * probe and a monotonic cancellation latch.
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

  const preToolUseHook: HookCallback = async (input, _toolUseId, hookOptions) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    if (hookOptions.signal.aborted || controller.signal.aborted) {
      return denyPreToolUse('run is stopping; tool execution denied');
    }
    const state = await probe();
    if (state === 'clear') return { continue: true };
    return denyPreToolUse(
      state === 'cancel_requested' ? CANCELLED_TOOL_REASON : UNKNOWN_TOOL_REASON,
    );
  };

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
    prependSdkHook(existing) {
      return prependCopilotCancellationHook(preToolUseHook, existing);
    },
  };
}
