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
    return this.terminal?.usage ?? { inputTokens: 0, outputTokens: 0 };
  }

  get tokenCounts(): TokenCounts {
    return this.terminal?.tokenCounts ?? { inputTokens: 0, outputTokens: 0 };
  }

  get costUsd(): number | undefined {
    return this.terminal?.costUsd;
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

    try {
      await writeCostLedger(this.config.db, {
        task_run_id: this.taskRunId,
        task_kind: this.kind,
        provider: this.resolved.provider,
        model: this.resolved.model,
        cost: effectiveCostUsd(
          this.resolved.model,
          this.terminal.tokenCounts,
          this.terminal.costUsd,
        ),
        currency: 'USD',
        tokens_in: this.terminal.usage.inputTokens,
        tokens_out: this.terminal.usage.outputTokens,
      });
    } catch (error) {
      console.error(`[${this.config.logScope}] writeCostLedger failed`, {
        task_run_id: this.taskRunId,
        kind: this.kind,
        err: error,
      });
    }

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
    await this.writeTerminal({
      status: 'failure',
      finishReason,
      errorMessage: error instanceof Error ? error.message : String(error),
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
  }): Promise<void> {
    if (this.terminalWriteAttempted) return;
    this.terminalWriteAttempted = true;
    try {
      await writeAiTaskRunFinished(this.config.db, {
        id: this.taskRunId,
        status: input.status,
        finish_reason: input.finishReason,
        usage: this.usage,
        cost_usd: this.costUsd,
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
