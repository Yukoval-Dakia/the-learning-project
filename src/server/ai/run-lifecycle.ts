import { type TaskKind, tasks } from '@/ai/registry';
import type { Db } from '@/db/client';
import { taskInputHash } from '@/server/judge/judge-execution-provenance';
import { createId } from '@paralleldrive/cuid2';
import { RETRY_ELAPSED_CAP_MS, isTransientAgentFailure } from './agent-run-error';
import {
  type AiTaskUsage,
  writeAiTaskAttemptFinished,
  writeAiTaskRunRetried,
  writeAiTaskRunStarted,
  writeToolCallLog,
} from './log';
import {
  type AttemptCostTruth,
  resolveAttemptCostTruth,
  unknownAttemptCostTruth,
} from './attempt-cost';
import type { TokenCounts } from './pricing';
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
 * SDK adapters only translate messages into `recordTerminalResult`, text
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
  private terminal: TerminalResultEvidence | undefined;
  private costTruthCache: AttemptCostTruth | undefined;
  private terminalWriteAttempted = false;
  private terminalSettled = false;
  private durableStart = false;

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

    await this.writeTerminal({
      status: 'success',
      finishReason: this.terminal.finishReason,
      errorMessage: undefined,
      outcome: 'success',
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

  /** Return false when the durable attempt truth could not be settled. */
  async finishFailure(error: unknown, finishReason = 'error'): Promise<boolean> {
    return this.writeTerminal({
      status: 'failure',
      finishReason,
      errorMessage: error instanceof Error ? error.message : String(error),
      outcome: isTransientAgentFailure(error) ? 'failed_retryable' : 'failed_permanent',
    });
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
    outcome: 'success' | 'failed_retryable' | 'failed_permanent';
  }): Promise<boolean> {
    if (!this.durableStart) return false;
    if (this.terminalWriteAttempted) return this.terminalSettled;
    this.terminalWriteAttempted = true;
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
      this.terminalSettled = true;
      return true;
    } catch (error) {
      console.error(`[${this.config.logScope}] writeAiTaskAttemptFinished ${input.status} failed`, {
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
      return false;
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
