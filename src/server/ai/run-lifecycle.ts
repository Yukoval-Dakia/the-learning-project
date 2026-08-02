import { type TaskKind, tasks } from '@/ai/registry';
import type { Db } from '@/db/client';
import { taskInputHash } from '@/server/judge/judge-execution-provenance';
import { createId } from '@paralleldrive/cuid2';
import { RETRY_ELAPSED_CAP_MS, isTransientAgentFailure } from './agent-run-error';
import {
  type AiTaskUsage,
  writeAiTaskRunFinished,
  writeAiTaskRunStarted,
  writeCostLedger,
  writeToolCallLog,
} from './log';
import { type TokenCounts, effectiveCostUsd } from './pricing';
import { type ResolvedProvider, hasGlobalProviderOverride, resolveTaskProvider } from './providers';

export type LifecycleUsage = AiTaskUsage;

export interface LifecycleResult {
  task_run_id: string;
  text: string;
  finishReason: string;
  usage: LifecycleUsage;
  cost_usd?: number;
  structured_output?: unknown;
}

export interface TerminalSuccess {
  usage: LifecycleUsage;
  tokenCounts: TokenCounts;
  costUsd?: number;
  finishReason: string;
  structuredOutput?: unknown;
}

export type ObservedRunUsage = Pick<TerminalSuccess, 'usage' | 'tokenCounts' | 'costUsd'>;

interface LifecycleConfig<TResult extends LifecycleResult> {
  db: Db;
  kind: TaskKind;
  taskRunId: string;
  timeoutMs: number;
  override?: { provider?: ResolvedProvider['provider']; model?: string };
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
 * SDK adapters only translate messages into `recordTerminalSuccess`, text
 * deltas and tool calls. This module owns the durable lifecycle invariant for
 * every adapter: started row, abort propagation, cost, terminal row and
 * after-run observation.
 */
export class AiRunLifecycle<TResult extends LifecycleResult = LifecycleResult> {
  readonly abortController = new AbortController();
  readonly resolved: ResolvedProvider;
  readonly taskRunId: string;
  readonly kind: TaskKind;

  private readonly timer: ReturnType<typeof setTimeout>;
  private terminal: TerminalSuccess | undefined;
  private observedUsage: ObservedRunUsage | undefined;
  private costWriteAttempted = false;
  private terminalWriteAttempted = false;

  constructor(private readonly config: LifecycleConfig<TResult>) {
    this.taskRunId = config.taskRunId;
    this.kind = config.kind;
    this.resolved = resolveTaskProvider(config.kind, config.override);
    this.timer = setTimeout(() => this.abortController.abort(), config.timeoutMs);

    if (config.signal) {
      if (config.signal.aborted) {
        this.abortController.abort();
      } else {
        config.signal.addEventListener('abort', () => this.abortController.abort(), { once: true });
      }
    }
  }

  get usage(): LifecycleUsage {
    return this.terminal?.usage ?? this.observedUsage?.usage ?? { inputTokens: 0, outputTokens: 0 };
  }

  get tokenCounts(): TokenCounts {
    return (
      this.terminal?.tokenCounts ??
      this.observedUsage?.tokenCounts ?? { inputTokens: 0, outputTokens: 0 }
    );
  }

  get costUsd(): number | undefined {
    return this.terminal?.costUsd ?? this.observedUsage?.costUsd;
  }

  get finishReason(): string {
    return this.terminal?.finishReason ?? 'unknown';
  }

  get structuredOutput(): unknown {
    return this.terminal?.structuredOutput;
  }

  get sawTerminalSuccess(): boolean {
    return this.terminal !== undefined;
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  async start(actualInput: unknown): Promise<void> {
    try {
      await writeAiTaskRunStarted(this.config.db, {
        id: this.taskRunId,
        task_kind: this.kind,
        provider: this.resolved.provider,
        model: this.resolved.model,
        input_hash: safeInputHash(actualInput),
        started_at: new Date(),
      });
    } catch (error) {
      console.error(`[${this.config.logScope}] writeAiTaskRunStarted failed`, {
        task_run_id: this.taskRunId,
        kind: this.kind,
        err: error,
      });
    }
  }

  recordTerminalSuccess(terminal: TerminalSuccess): void {
    this.terminal = terminal;
    this.observedUsage = terminal;
  }

  /**
   * Keep the latest aggregate SDK usage even when no success terminal arrives.
   * Result-error messages carry authoritative aggregate usage; budget aborts can
   * still contribute the assistant turns observed before the stream was cut.
   */
  recordObservedUsage(observation: ObservedRunUsage): void {
    this.observedUsage = observation;
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

    await this.writeObservedCost('success');

    await this.writeTerminal({
      status: 'success',
      finishReason: this.terminal.finishReason,
      errorMessage: undefined,
    });

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

  async finishFailure(error: unknown, finishReason = 'error'): Promise<void> {
    const failureOutcome = isTransientAgentFailure(error)
      ? ('failed_retryable' as const)
      : ('failed_permanent' as const);
    const observedCost = this.hasObservedBillableUsage()
      ? effectiveCostUsd(this.resolved.model, this.tokenCounts, this.costUsd)
      : undefined;
    if (observedCost !== undefined) {
      const effectiveObservation = {
        usage: this.usage,
        tokenCounts: this.tokenCounts,
        costUsd: observedCost,
      };
      this.observedUsage = effectiveObservation;
      if (this.terminal) this.terminal = { ...this.terminal, costUsd: observedCost };
    }
    await this.writeObservedCost(failureOutcome);
    await this.writeTerminal({
      status: 'failure',
      finishReason,
      errorMessage: error instanceof Error ? error.message : String(error),
      costUsd: observedCost,
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  abort(): void {
    clearTimeout(this.timer);
    this.abortController.abort();
  }

  private async writeTerminal(input: {
    status: 'success' | 'failure';
    finishReason: string;
    errorMessage: string | undefined;
    costUsd?: number;
  }): Promise<void> {
    if (this.terminalWriteAttempted) return;
    this.terminalWriteAttempted = true;
    try {
      await writeAiTaskRunFinished(this.config.db, {
        id: this.taskRunId,
        status: input.status,
        finish_reason: input.finishReason,
        usage: this.usage,
        cost_usd: input.costUsd ?? this.costUsd,
        error_message: input.errorMessage,
      });
    } catch (error) {
      console.error(`[${this.config.logScope}] writeAiTaskRunFinished ${input.status} failed`, {
        task_run_id: this.taskRunId,
        kind: this.kind,
        err: error,
      });
      console.warn(`[${this.config.logScope}] task_run_stuck_in_running`, {
        event: 'task_run_stuck_in_running',
        task_run_id: this.taskRunId,
        kind: this.kind,
        intended_status: input.status,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private hasObservedBillableUsage(): boolean {
    return (
      this.usage.inputTokens > 0 ||
      this.usage.outputTokens > 0 ||
      (this.costUsd !== undefined && this.costUsd > 0)
    );
  }

  private async writeObservedCost(
    outcome: 'success' | 'failed_retryable' | 'failed_permanent',
  ): Promise<void> {
    if (this.costWriteAttempted) return;
    this.costWriteAttempted = true;
    // A process/config failure before any provider turn is not a paid run. Keep
    // it visible in ai_task_runs without manufacturing a zero-cost ledger row.
    // Successful terminals retain the pre-existing one-row accounting contract,
    // including genuinely zero-marginal subscription runs.
    if (outcome !== 'success' && !this.hasObservedBillableUsage()) return;
    try {
      await writeCostLedger(this.config.db, {
        task_run_id: this.taskRunId,
        task_kind: this.kind,
        provider: this.resolved.provider,
        model: this.resolved.model,
        cost: effectiveCostUsd(this.resolved.model, this.tokenCounts, this.costUsd),
        currency: 'USD',
        tokens_in: this.usage.inputTokens,
        tokens_out: this.usage.outputTokens,
        outcome,
      });
    } catch (error) {
      console.error(`[${this.config.logScope}] writeCostLedger failed`, {
        task_run_id: this.taskRunId,
        kind: this.kind,
        outcome,
        err: error,
      });
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
