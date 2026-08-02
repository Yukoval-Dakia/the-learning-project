import { type TaskKind, tasks } from '@/ai/registry';
import type { Db } from '@/db/client';
import { taskInputHash } from '@/server/judge/judge-execution-provenance';
import { createId } from '@paralleldrive/cuid2';
import { RETRY_ELAPSED_CAP_MS, isTransientAgentFailure } from './agent-run-error';
import {
  type AttemptCostTruth,
  resolveAttemptCostTruth,
  unknownAttemptCostTruth,
} from './attempt-cost';
import {
  type AiTaskUsage,
  writeAiTaskAttemptFinished,
  writeAiTaskRunRetried,
  writeAiTaskRunStarted,
  writeToolCallLog,
} from './log';
import type { TokenCounts } from './pricing';
import {
  ProviderSessionAdmissionError,
  type ProviderSessionAdmissionPlan,
  acquireProviderSession,
  resolveProviderSessionAdmissionPlan,
} from './provider-session-admission';
import { type ResolvedProvider, hasGlobalProviderOverride, resolveTaskProvider } from './providers';

export type LifecycleUsage = AiTaskUsage;

export interface LifecycleResult {
  task_run_id: string;
  text: string;
  finishReason: string;
  usage: LifecycleUsage;
  cost_usd?: number;
  cost_basis: AttemptCostTruth['basis'];
  cost_ref: string;
  structured_output?: unknown;
}

/** Usage/cost evidence carried by either SDKResultSuccess or SDKResultError. */
export interface TerminalResultEvidence {
  usage: LifecycleUsage;
  tokenCounts: TokenCounts;
  costUsd?: number;
  finishReason: string;
  structuredOutput?: unknown;
}

interface LifecycleConfig<TResult extends LifecycleResult> {
  db: Db;
  kind: TaskKind;
  taskRunId: string;
  timeoutMs: number;
  /**
   * Optional controller shared with in-process tools spawned by this attempt.
   * The lifecycle remains its owner: provider timeout, lease fencing and caller
   * cancellation all abort this exact controller so borrowed child work cannot
   * outlive the parent admission permit.
   */
  abortController?: AbortController;
  override?: { provider?: ResolvedProvider['provider']; model?: string };
  /** Active outer central attempt when a DomainTool starts a nested task. */
  parentTaskRunId?: string;
  /** Absolute wall-clock bound for starting this provider attempt (retry gate). */
  providerStartDeadlineAt?: number;
  signal?: AbortSignal;
  logScope: string;
  afterRun?: (result: TResult) => Promise<void> | void;
}

export interface LifecycleRetryContext {
  enableTransientRetry?: boolean;
  override?: { provider?: ResolvedProvider['provider']; model?: string };
}

export interface LifecycleAttemptDecision {
  willRetry: boolean;
  elapsedMs: number;
}

type AttemptTerminalStatus = 'success' | 'failure';

/** A provider result exists, but its first durable terminal projection did not settle. */
export class AttemptSettlementError extends Error {
  readonly taskRunId: string;
  readonly intendedStatus: AttemptTerminalStatus;

  constructor(input: {
    kind: string;
    taskRunId: string;
    intendedStatus: AttemptTerminalStatus;
  }) {
    super(
      `[${input.kind}] cannot report ${input.intendedStatus} before durable attempt settlement: ${input.taskRunId}`,
    );
    this.name = 'AttemptSettlementError';
    this.taskRunId = input.taskRunId;
    this.intendedStatus = input.intendedStatus;
  }
}

function safeInputHash(input: unknown): string {
  try {
    return taskInputHash(input);
  } catch {
    return taskInputHash(String(input));
  }
}

/**
 * One task attempt's state owner.
 *
 * SDK adapters only translate messages into `recordTerminalResult`, text
 * deltas and tool calls. This module owns the durable lifecycle invariant for
 * every adapter: started row, abort propagation, cost, terminal row and
 * after-run observation. Terminal methods have one sequential owner; a
 * concurrent terminal call is unsupported and fails closed rather than joining
 * the in-flight transaction.
 */
export class AiRunLifecycle<TResult extends LifecycleResult = LifecycleResult> {
  readonly abortController: AbortController;
  readonly resolved: ResolvedProvider;
  readonly taskRunId: string;
  readonly kind: TaskKind;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly admissionPlan: ProviderSessionAdmissionPlan;
  private admissionFailure: ProviderSessionAdmissionError | undefined;
  private terminal: TerminalResultEvidence | undefined;
  private costTruthCache: AttemptCostTruth | undefined;
  private readonly terminalWriteAttempts = new Set<AttemptTerminalStatus>();
  private terminalWriteInFlight = false;
  private terminalSettledStatus: AttemptTerminalStatus | undefined;
  private lastTerminalWriteError: unknown;
  private durableStart = false;

  constructor(private readonly config: LifecycleConfig<TResult>) {
    this.abortController = config.abortController ?? new AbortController();
    this.taskRunId = config.taskRunId;
    this.kind = config.kind;
    this.resolved = resolveTaskProvider(config.kind, config.override);
    this.admissionPlan = resolveProviderSessionAdmissionPlan(this.resolved.provider);

    if (config.signal) {
      if (config.signal.aborted) {
        this.abortController.abort();
      } else {
        config.signal.addEventListener('abort', () => this.abortController.abort(), { once: true });
      }
    }
  }

  get usage(): LifecycleUsage {
    return this.terminal?.usage ?? { inputTokens: 0, outputTokens: 0 };
  }

  get tokenCounts(): TokenCounts {
    return this.terminal?.tokenCounts ?? { inputTokens: 0, outputTokens: 0 };
  }

  get costTruth(): AttemptCostTruth {
    if (!this.costTruthCache) {
      this.costTruthCache = this.terminal
        ? resolveAttemptCostTruth({
            provider: this.resolved.provider,
            model: this.resolved.model,
            tokens: this.terminal.tokenCounts,
            reportedCostUsd: this.terminal.costUsd,
          })
        : unknownAttemptCostTruth(this.resolved.provider, this.resolved.model);
    }
    return this.costTruthCache;
  }

  get costUsd(): number | undefined {
    return this.costTruth.amountUsd ?? undefined;
  }

  get costBasis(): AttemptCostTruth['basis'] {
    return this.costTruth.basis;
  }

  get costRef(): string {
    return this.costTruth.ref;
  }

  get finishReason(): string {
    return this.terminal?.finishReason ?? 'unknown';
  }

  get structuredOutput(): unknown {
    return this.terminal?.structuredOutput;
  }

  get sawTerminalResult(): boolean {
    return this.terminal !== undefined;
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  get started(): boolean {
    return this.durableStart;
  }

  /**
   * Own the complete provider-session boundary without holding the permit during
   * terminal DB settlement. Admission wait precedes the durable model-attempt
   * row and the execution timer, so queue time can never masquerade as model
   * runtime or create an unknown-cost YUK-841 attempt that never called the SDK.
   */
  async withProviderSession<T>(actualInput: unknown, run: () => Promise<T>): Promise<T> {
    // Canonicalization may synchronously hash binary input. Prepare it before
    // acquiring the lease so large local inputs cannot starve its heartbeat;
    // the durable attempt row itself still starts only after admission.
    const inputHash = safeInputHash(actualInput);
    const permit =
      this.admissionPlan.mode === 'off'
        ? undefined
        : await acquireProviderSession({
            db: this.config.db,
            kind: this.kind,
            taskRunId: this.taskRunId,
            parentTaskRunId: this.config.parentTaskRunId,
            executionTimeoutMs: this.config.timeoutMs,
            signal: this.abortController.signal,
            plan: this.admissionPlan,
            deadlineAt: this.config.providerStartDeadlineAt,
            onLeaseLost: (error) => {
              this.admissionFailure ??= error;
              this.abortController.abort();
            },
          });

    let outcome: { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
    try {
      if (
        this.config.providerStartDeadlineAt !== undefined &&
        Date.now() >= this.config.providerStartDeadlineAt
      ) {
        throw new ProviderSessionAdmissionError({
          reason: 'wait_timeout',
          laneId: this.resolved.provider,
          taskRunId: this.taskRunId,
          cause: new Error('provider retry start window elapsed before SDK invocation'),
        });
      }
      await this.startWithInputHash(inputHash);
      // Admission can return just inside the retry window while the durable
      // start write blocks past it. Recheck at the final pre-SDK seam so the
      // existing elapsed gate is never expanded by control-plane DB latency.
      if (
        this.config.providerStartDeadlineAt !== undefined &&
        Date.now() >= this.config.providerStartDeadlineAt
      ) {
        throw new ProviderSessionAdmissionError({
          reason: 'wait_timeout',
          laneId: this.resolved.provider,
          taskRunId: this.taskRunId,
          cause: new Error('provider retry start window elapsed during durable start'),
        });
      }
      this.armExecutionTimer();
      const value = await run();
      if (this.admissionFailure) throw this.admissionFailure;
      outcome = { status: 'fulfilled', value };
    } catch (error) {
      outcome = { status: 'rejected', reason: this.admissionFailure ?? error };
    }

    this.clearExecutionTimer();
    await permit?.release();
    // Cover a heartbeat that fenced this attempt after the provider callback
    // resolved but before release stopped the heartbeat.
    if (this.admissionFailure) throw this.admissionFailure;
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  }

  async start(actualInput: unknown): Promise<void> {
    await this.startWithInputHash(safeInputHash(actualInput));
  }

  private async startWithInputHash(inputHash: string): Promise<void> {
    try {
      await writeAiTaskRunStarted(this.config.db, {
        id: this.taskRunId,
        task_kind: this.kind,
        provider: this.resolved.provider,
        model: this.resolved.model,
        input_hash: inputHash,
        started_at: new Date(),
      });
      this.durableStart = true;
    } catch (error) {
      console.error(`[${this.config.logScope}] writeAiTaskRunStarted failed`, {
        task_run_id: this.taskRunId,
        kind: this.kind,
        err: error,
      });
      // Tracking is a load-bearing boundary: never acquire provider cost when
      // the durable attempt identity could not be created.
      throw error;
    }
  }

  recordTerminalResult(terminal: TerminalResultEvidence): void {
    this.terminal = terminal;
    this.costTruthCache = resolveAttemptCostTruth({
      provider: this.resolved.provider,
      model: this.resolved.model,
      tokens: terminal.tokenCounts,
      reportedCostUsd: terminal.costUsd,
    });
  }

  async recordToolCall(input: {
    toolName: string;
    inputJson: Record<string, unknown>;
    iteration: number;
    latencyMs: number;
  }): Promise<void> {
    try {
      await writeToolCallLog(this.config.db, {
        task_run_id: this.taskRunId,
        task_kind: this.kind,
        tool_name: input.toolName,
        input_json: input.inputJson,
        output_json: {},
        iteration: input.iteration,
        latency_ms: input.latencyMs,
        cost: 0,
      });
    } catch (error) {
      console.error(`[${this.config.logScope}] writeToolCallLog failed`, {
        task_run_id: this.taskRunId,
        kind: this.kind,
        tool: input.toolName,
        err: error,
      });
    }
  }

  async finishSuccess(result: TResult): Promise<void> {
    if (!this.terminal) {
      throw new Error(`[${this.kind}] cannot finish success without a terminal SDK result`);
    }

    const settled = await this.writeTerminal({
      status: 'success',
      finishReason: this.terminal.finishReason,
      errorMessage: undefined,
      outcome: 'success',
    });
    if (!settled) {
      throw new AttemptSettlementError({
        kind: this.kind,
        taskRunId: this.taskRunId,
        intendedStatus: 'success',
      });
    }

    if (this.config.afterRun) {
      try {
        await this.config.afterRun(result);
      } catch (error) {
        console.error(`[${this.config.logScope}] afterRun middleware failed`, {
          task_run_id: this.taskRunId,
          kind: this.kind,
          err: error,
        });
      }
    }
  }

  /** Return false when the durable attempt truth could not be settled. */
  async finishFailure(error: unknown, finishReason = 'error'): Promise<boolean> {
    const settled = await this.writeTerminal({
      status: 'failure',
      finishReason,
      errorMessage: error instanceof Error ? error.message : String(error),
      outcome: isTransientAgentFailure(error) ? 'failed_retryable' : 'failed_permanent',
    });
    if (!settled && !this.terminalSettledStatus) {
      const writeError = this.lastTerminalWriteError ?? error;
      console.warn(`[${this.config.logScope}] task_run_stuck_in_running`, {
        event: 'task_run_stuck_in_running',
        task_run_id: this.taskRunId,
        kind: this.kind,
        intended_status: 'failure',
        err: writeError instanceof Error ? writeError.message : String(writeError),
      });
    }
    return settled;
  }

  /** Best-effort conservative marker: false negatives are allowed, false positives are not. */
  async markRetried(): Promise<void> {
    try {
      const marked = await writeAiTaskRunRetried(this.config.db, this.taskRunId);
      if (!marked) {
        console.warn(`[${this.config.logScope}] task_run_retry_marker_not_written`, {
          event: 'task_run_retry_marker_not_written',
          task_run_id: this.taskRunId,
          kind: this.kind,
        });
      }
    } catch (error) {
      console.warn(`[${this.config.logScope}] task_run_retry_marker_not_written`, {
        event: 'task_run_retry_marker_not_written',
        task_run_id: this.taskRunId,
        kind: this.kind,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  dispose(): void {
    this.clearExecutionTimer();
  }

  abort(): void {
    this.clearExecutionTimer();
    this.abortController.abort();
  }

  private armExecutionTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.abortController.abort(), this.config.timeoutMs);
  }

  private clearExecutionTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async writeTerminal(input: {
    status: AttemptTerminalStatus;
    finishReason: string;
    errorMessage: string | undefined;
    outcome: 'success' | 'failed_retryable' | 'failed_permanent';
  }): Promise<boolean> {
    if (!this.durableStart) return false;
    if (this.terminalSettledStatus) return this.terminalSettledStatus === input.status;
    if (this.terminalWriteInFlight) return false;
    if (this.terminalWriteAttempts.has(input.status)) return false;

    // A failed success projection may be downgraded exactly once to an
    // application failure. Never retry an ambiguous status, upgrade failure to
    // success, or allow concurrent terminal transactions. The DB's running-row
    // CAS and unique attempt ledger remain the final double-write guards.
    if (this.terminalWriteAttempts.size > 0 && input.status !== 'failure') return false;
    this.terminalWriteAttempts.add(input.status);
    this.terminalWriteInFlight = true;
    try {
      const settled = await writeAiTaskAttemptFinished(this.config.db, {
        id: this.taskRunId,
        status: input.status,
        finish_reason: input.finishReason,
        usage: this.usage,
        cost_truth: this.costTruth,
        outcome: input.outcome,
        error_message: input.errorMessage,
      });
      if (!settled) {
        throw new Error(`cannot settle missing or non-running AI task attempt: ${this.taskRunId}`);
      }
      this.terminalSettledStatus = input.status;
      this.lastTerminalWriteError = undefined;
      return true;
    } catch (error) {
      this.lastTerminalWriteError = error;
      console.error(`[${this.config.logScope}] writeAiTaskAttemptFinished ${input.status} failed`, {
        task_run_id: this.taskRunId,
        kind: this.kind,
        err: error,
      });
      return false;
    } finally {
      this.terminalWriteInFlight = false;
    }
  }
}

export function createRunLifecycle<TResult extends LifecycleResult>(
  config: Omit<LifecycleConfig<TResult>, 'taskRunId'> & { taskRunId?: string },
): AiRunLifecycle<TResult> {
  return new AiRunLifecycle({
    ...config,
    taskRunId: config.taskRunId ?? createId(),
  });
}

export function transientRetryEnabled(ctx: LifecycleRetryContext): boolean {
  if (ctx.enableTransientRetry !== true) return false;
  if (ctx.override?.provider || ctx.override?.model) return false;
  if (hasGlobalProviderOverride()) return false;
  return true;
}

export function maxLifecycleAttempts(kind: TaskKind, ctx: LifecycleRetryContext): number {
  return 1 + (transientRetryEnabled(ctx) ? tasks[kind].budget.transientRetries : 0);
}

export function classifyLifecycleRetry(input: {
  attempt: number;
  maxAttempts: number;
  firstAttemptStartedAt: number;
  error: unknown;
  now?: number;
}): LifecycleAttemptDecision {
  const elapsedMs = (input.now ?? Date.now()) - input.firstAttemptStartedAt;
  return {
    elapsedMs,
    willRetry:
      input.attempt < input.maxAttempts &&
      isTransientAgentFailure(input.error) &&
      elapsedMs < RETRY_ELAPSED_CAP_MS,
  };
}
