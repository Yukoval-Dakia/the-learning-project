import { createId } from '@paralleldrive/cuid2';
import {
  ProviderSessionWallClockBudgetError,
  RETRY_ELAPSED_CAP_MS,
  isTransientAgentFailure,
} from '@/ai/agent-run-error';
import {
  type ExecutableHelpBasis,
  type SealedHelpLatency,
  helpCost,
  helpModalityForTaskKind,
  helpTerminalForAttempt,
  nonnegativeElapsed,
  sealHelpLatency,
} from '@/ai/help-latency';
import type { TaskTimeoutSource } from '@/ai/task-budget';
import type {
  AiTaskUsage,
  LifecycleResult,
  AiTaskUsage as LifecycleUsage,
  NoteGeneratePhaseTimings,
  TransportAbortInitiator,
} from '@/ai/task-result';
import type { TaskDefinition } from '@/ai/task-spec';
import { type TaskKind, tasks } from '@/capabilities/task-registry';
import { taskInputHash } from '@/core/task-input-hash';
import type { Db } from '@/db/client';
import { writeToolCallLog } from '@/kernel/tools/call-evidence';
import {
  type AttemptCostTruth,
  resolveAttemptCostTruth,
  unknownAttemptCostTruth,
} from './attempt-cost';
import { type ModelBinding, explicitProviderRouting } from './execution-adapter';
import {
  type TraceSpan,
  isLaminarTracingEnabled,
  startTraceSpan,
  traceMetadata,
  withTraceContext,
} from './laminar-tracing';
import { writeAiTaskAttemptFinished, writeAiTaskRunRetried, writeAiTaskRunStarted } from './log';
import {
  type ModelProfile,
  assertModelProfileCapabilityFit,
  resolveModelProfile,
} from './model-profiles';
import { piCatalogCostUsd } from './pi-catalog-cost';
import type { TokenCounts } from './pricing';
import { acquireProviderSession } from './provider-session-admission';
import {
  ProviderSessionAdmissionError,
  type ProviderSessionAdmissionPlan,
  resolveProviderSessionAdmissionPlan,
} from './provider-session-admission-policy';
import {
  type ProviderTransportCollector,
  createProviderTransportCollector,
} from './provider-transport';
import { type ResolvedProvider, hasGlobalProviderOverride, resolveTaskProvider } from './providers';
import { estimateAbortedUsage } from './timeout-usage';

/** Usage/cost evidence carried by either SDKResultSuccess or SDKResultError. */
export interface TerminalResultEvidence {
  usage: LifecycleUsage;
  tokenCounts: TokenCounts;
  /** YUK-1557 — completed assistant turns; persisted beside the token counters. */
  numTurns?: number;
  /** YUK-1557 — set when an estimate fills a terminal frame with no usable usage. */
  priceOrigin?: 'timeout-estimate' | 'failure-estimate';
  /** Distinguishes missing usage from explicitly observed zero token counts. */
  tokenUsageObserved?: boolean;
  costUsd?: number;
  finishReason: string;
  structuredOutput?: unknown;
}

export type ObservedRunUsage = Pick<
  TerminalResultEvidence,
  'usage' | 'tokenCounts' | 'numTurns' | 'tokenUsageObserved' | 'costUsd'
> & {
  /** Set when tokens and any catalog USD came from an aborted stream, not a final usage payload. */
  priceOrigin?: 'timeout-estimate' | 'failure-estimate';
};

interface LifecycleConfig<TResult extends LifecycleResult> {
  db: Db;
  kind: TaskKind;
  taskRunId: string;
  timeoutMs: number;
  /** YUK-1630 — which budget layer produced `timeoutMs`; forwarded to transport evidence. */
  timeoutSource?: TaskTimeoutSource;
  /**
   * Optional controller shared with in-process tools. The lifecycle owns it:
   * timeout, lease fencing and caller cancellation all abort this controller.
   */
  abortController?: AbortController;
  override?: { provider?: ResolvedProvider['provider']; model?: string };
  /**
   * YUK-1013 — per-run model binding. Provider/model merge into resolution
   * (override wins per-field); `effort` feeds run metadata, `adapter` the engine.
   */
  modelBinding?: ModelBinding;
  /** Active outer central attempt when a DomainTool starts a nested task. */
  parentTaskRunId?: string;
  /** Absolute bound for beginning a retry attempt; execution keeps its own budget. */
  providerStartDeadlineAt?: number;
  /** Absolute wall-clock bound shared by admission, adapter startup and execution. */
  providerSessionDeadlineAt?: number;
  signal?: AbortSignal;
  logScope: string;
  compiledPromptProvenance?: {
    compiledPromptHash: string;
    promptCodecVersion: string;
    promptCodecMode: 'cold' | 'resume';
    promptContextDigest: string;
  };
  afterRun?: (result: TResult) => Promise<void> | void;
}

export interface LifecycleRetryContext {
  enableTransientRetry?: boolean;
  override?: { provider?: ResolvedProvider['provider']; model?: string };
  modelBinding?: ModelBinding;
}

export interface LifecycleAttemptDecision {
  willRetry: boolean;
  elapsedMs: number;
}

export interface ProviderSessionExecution<T> {
  /** Start the exact task-configured provider transport without submitting a prompt. */
  prepare(): Promise<void>;
  /** Submit the prompt and consume the provider-backed session. */
  run(): Promise<T>;
  /** Close either the unused warm transport or the active query. */
  close(): Promise<void> | void;
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
 * One task attempt's state owner: started row, abort propagation, cost, terminal
 * row and after-run observation. Terminal methods have one sequential owner; a
 * concurrent terminal call fails closed rather than joining the transaction.
 */
export class AiRunLifecycle<TResult extends LifecycleResult = LifecycleResult> {
  readonly abortController: AbortController;
  readonly resolved: ResolvedProvider;
  readonly taskRunId: string;
  readonly kind: TaskKind;
  /**
   * YUK-924 — effective ModelProfile for the resolved lane, incl. `source`
   * ('binding' | 'catalog' | 'defaults') for run metadata.
   */
  readonly modelProfile: ModelProfile;
  /**
   * YUK-1630 — this attempt's transport evidence sink, forwarded to the adapter.
   * Its snapshot rides `usage_json` on every terminal write, including aborts.
   */
  readonly transportEvidence: ProviderTransportCollector;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly admissionPlan: ProviderSessionAdmissionPlan;
  private admissionFailure: ProviderSessionAdmissionError | undefined;
  private terminal: TerminalResultEvidence | undefined;
  private observedUsage: ObservedRunUsage | undefined;
  private costTruthCache: AttemptCostTruth | undefined;
  private readonly terminalWriteAttempts = new Set<AttemptTerminalStatus>();
  private terminalWriteInFlight = false;
  private terminalSettledStatus: AttemptTerminalStatus | undefined;
  private lastTerminalWriteError: unknown;
  private durableStart = false;
  private trace: TraceSpan | undefined;
  private traceOutcome: 'success' | 'error' | 'cancelled' | 'not_started' = 'not_started';
  private notePhases: NoteGeneratePhaseTimings | undefined;
  private readonly attemptOriginAt = Date.now();
  private helpClock:
    | { endedAt: number; firstTokenAt?: number; completeArtifact: boolean }
    | undefined;
  private executableHelp: { basis: ExecutableHelpBasis; at: number } | undefined;
  private helpLatencySeal: SealedHelpLatency | undefined;

  withTracing<T>(callback: () => T): T {
    if (!isLaminarTracingEnabled()) return callback();
    if (!this.trace)
      traceMetadata({
        task_kind: this.kind,
        task_run_id: this.taskRunId,
        parent_task_run_id: this.config.parentTaskRunId,
      });
    this.trace ??= startTraceSpan('task.attempt', {
      task_kind: this.kind,
      task_run_id: this.taskRunId,
      parent_task_run_id: this.config.parentTaskRunId,
      provider: this.resolved.provider,
      model: this.resolved.model,
      business_outcome: 'unassessed',
      additive_usage: false,
      includes_child_usage: true,
    });
    return withTraceContext(this.trace, callback);
  }

  constructor(private readonly config: LifecycleConfig<TResult>) {
    this.abortController = config.abortController ?? new AbortController();
    this.taskRunId = config.taskRunId;
    this.kind = config.kind;
    // YUK-1013 — merge the binding here (override wins per-field) so every
    // lifecycle caller gets the same provider-resolution layering.
    this.resolved = resolveTaskProvider(config.kind, explicitProviderRouting(config));
    // YUK-924 P2 — fail-closed capability gate: a task declaring needsToolCall /
    // isMultimodal may only run on a profile that CONFIRMS it ('unknown' rejects).
    // Thrown before any admission row, attempt row or paid call.
    assertModelProfileCapabilityFit(
      tasks[config.kind],
      this.resolved.provider,
      this.resolved.model,
    );
    this.modelProfile = resolveModelProfile(this.resolved.provider, this.resolved.model);
    this.admissionPlan = resolveProviderSessionAdmissionPlan(this.resolved.provider);
    this.transportEvidence = createProviderTransportCollector({
      taskTimeoutMs: config.timeoutMs,
      ...(config.timeoutSource !== undefined ? { timeoutSource: config.timeoutSource } : {}),
      ...(config.providerSessionDeadlineAt !== undefined
        ? { callerDeadlineAt: config.providerSessionDeadlineAt }
        : {}),
    });

    if (config.signal) {
      if (config.signal.aborted) {
        this.initiateAbort('caller_signal');
      } else {
        config.signal.addEventListener('abort', () => this.initiateAbort('caller_signal'), {
          once: true,
        });
      }
    }
  }

  /**
   * Record the abort initiator synchronously BEFORE the signal fires so wire
   * evidence names the real layer. Only the first transition records a marker.
   */
  private initiateAbort(kind: TransportAbortInitiator): void {
    if (!this.abortController.signal.aborted) {
      this.transportEvidence.noteAbortInitiated(kind);
    }
    this.abortController.abort();
  }

  get usage(): LifecycleUsage {
    const base = this.terminal?.usage ??
      this.observedUsage?.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        numTurns: 0,
      };
    const phased = !this.notePhases ? base : { ...base, phases: { ...this.notePhases } };
    // YUK-1630 — transport evidence sits beside the token truth and never feeds
    // it; attached only when the controlled lane was armed, so an unobserved lane
    // cannot persist `requests: []` that reads as false `not_sent` evidence.
    if (!this.transportEvidence.isArmed) return phased;
    return { ...phased, transport: this.transportEvidence.snapshot() };
  }

  /** Long-note phase timings. Other task kinds ignore the call. */
  recordNotePhases(patch: NoteGeneratePhaseTimings): void {
    if (this.kind !== 'NoteGenerateTask') return;
    this.notePhases = { ...this.notePhases, ...patch };
  }

  /**
   * Persist a bounded estimate when a provider call ended without usable usage:
   * `failure-estimate` for non-abort failures, `timeout-estimate` for budget aborts.
   */
  async recordEstimatedUsage(input: {
    promptText: string;
    output: Parameters<typeof estimateAbortedUsage>[1];
    priceOrigin: 'timeout-estimate' | 'failure-estimate';
  }): Promise<void> {
    const terminalHasUsableUsage =
      this.terminal !== undefined &&
      (this.terminal.tokenUsageObserved === true ||
        this.terminal.usage.inputTokens > 0 ||
        this.terminal.usage.outputTokens > 0 ||
        this.terminal.costUsd !== undefined);
    if (terminalHasUsableUsage) return;
    const observed = this.observedUsage;
    if (
      observed?.tokenUsageObserved === true &&
      (observed.usage.inputTokens > 0 || observed.usage.outputTokens > 0)
    ) {
      return;
    }
    const estimate = estimateAbortedUsage(input.promptText, input.output);
    const provider = this.resolved.provider;
    let catalogCost: number | undefined;
    if (provider === 'opencode-go' || provider === 'openai' || provider === 'xiaomi-token-plan') {
      const priced = await piCatalogCostUsd(provider, this.resolved.model, estimate).catch(
        () => null,
      );
      if (priced !== null) catalogCost = priced;
    }
    const estimated = {
      priceOrigin: input.priceOrigin,
      numTurns: 1,
      tokenUsageObserved: true,
      usage: {
        inputTokens: estimate.inputTokens,
        outputTokens: estimate.outputTokens,
        usage_basis: 'estimated' as const,
      },
      tokenCounts: {
        inputTokens: estimate.inputTokens,
        outputTokens: estimate.outputTokens,
      },
      ...(catalogCost !== undefined ? { costUsd: catalogCost } : {}),
    };
    if (this.terminal) {
      this.terminal = { ...this.terminal, ...estimated };
    } else {
      this.observedUsage = estimated;
    }
    this.costTruthCache = undefined;
  }

  get tokenCounts(): TokenCounts {
    return (
      this.terminal?.tokenCounts ??
      this.observedUsage?.tokenCounts ?? { inputTokens: 0, outputTokens: 0 }
    );
  }

  /**
   * YUK-1557 — persisted usage: `usage` stays the public run-result shape while
   * the terminal row carries cache counters and completed turns.
   */
  private get persistedUsage(): AiTaskUsage {
    const counts = this.tokenCounts;
    const base: AiTaskUsage = {
      ...this.usage,
      cacheReadTokens: counts.cacheReadTokens ?? 0,
      cacheWriteTokens: counts.cacheCreationTokens ?? 0,
      numTurns: this.terminal?.numTurns ?? this.observedUsage?.numTurns ?? 0,
    };
    return this.helpLatencySeal ? { ...base, help_latency: this.helpLatencySeal } : base;
  }

  /** Model-loop clock for a help attempt. Other task kinds ignore it. */
  noteHelpProviderClock(input: {
    endedAt: number;
    firstTokenAt?: number;
    completeArtifact: boolean;
  }): void {
    if (helpModalityForTaskKind(this.kind) === null) return;
    this.helpClock = input;
  }

  /** Verified executable exit observed before the attempt row is sealed. */
  noteExecutableHelp(basis: ExecutableHelpBasis, at = Date.now()): void {
    if (helpModalityForTaskKind(this.kind) === null) return;
    if (this.executableHelp) return;
    this.executableHelp = { basis, at };
  }

  /**
   * Cache the help-latency seal. The first call wins so the thrown error and
   * the terminal row carry the same object.
   */
  sealHelpLatency(status: 'success' | 'failure'): SealedHelpLatency | undefined {
    const modality = helpModalityForTaskKind(this.kind);
    if (!modality) return undefined;
    const cachedStatus =
      this.helpLatencySeal === undefined
        ? undefined
        : this.helpLatencySeal.terminal === 'success'
          ? 'success'
          : 'failure';
    if (this.helpLatencySeal && cachedStatus === status) return this.helpLatencySeal;
    const endedAt = this.helpClock?.endedAt ?? Date.now();
    const executableAt = this.executableHelp?.at;
    const completeAt = executableAt ?? (this.helpClock?.completeArtifact ? endedAt : undefined);
    const truth = this.costTruth;
    this.helpLatencySeal = sealHelpLatency({
      origin_at: this.attemptOriginAt,
      terminal: helpTerminalForAttempt({
        status,
        aborted: this.aborted,
        abortKinds: this.transportEvidence.abortInitiatorKinds(),
        callerAbortReason: this.config.signal?.reason,
      }),
      modality,
      executable_help: this.executableHelp?.basis ?? null,
      marks: {
        first_token_ms:
          this.helpClock?.firstTokenAt === undefined
            ? null
            : nonnegativeElapsed(this.attemptOriginAt, this.helpClock.firstTokenAt),
        first_executable_help_ms:
          executableAt === undefined
            ? null
            : nonnegativeElapsed(this.attemptOriginAt, executableAt),
        complete_artifact_ms:
          completeAt === undefined ? null : nonnegativeElapsed(this.attemptOriginAt, completeAt),
        calls_settled_ms: nonnegativeElapsed(this.attemptOriginAt, endedAt),
      },
      cost: helpCost(truth.basis, truth.amountUsd),
      progress_budget: {
        budget_ms: this.config.timeoutMs,
        elapsed_ms: nonnegativeElapsed(this.attemptOriginAt, endedAt),
      },
    });
    return this.helpLatencySeal;
  }

  get costTruth(): AttemptCostTruth {
    if (!this.costTruthCache) {
      const evidence = this.terminal ?? this.observedUsage;
      this.costTruthCache = evidence
        ? resolveAttemptCostTruth({
            provider: this.resolved.provider,
            model: this.resolved.model,
            tokens: evidence.tokenCounts,
            tokensObserved: evidence.tokenUsageObserved,
            reportedCostUsd: evidence.costUsd,
            priceOrigin: 'priceOrigin' in evidence ? evidence.priceOrigin : undefined,
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

  /** Clamp a provider phase's own timeout to the remaining caller wall clock. */
  providerPhaseTimeoutMs(maxTimeoutMs: number): number {
    const remainingMs = Math.min(
      maxTimeoutMs,
      this.config.providerStartDeadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : this.config.providerStartDeadlineAt - Date.now(),
      this.config.providerSessionDeadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : this.config.providerSessionDeadlineAt - Date.now(),
    );
    return Math.max(1, remainingMs);
  }

  /**
   * Own the provider-session boundary without holding the permit during terminal
   * settlement. Admission wait precedes the durable attempt row and timer, so queue
   * time never masquerades as model runtime.
   */
  async withProviderSession<T>(
    actualInput: unknown,
    execution: ProviderSessionExecution<T>,
  ): Promise<T> {
    // Canonicalization may synchronously hash binary input. Prepare it before the
    // lease so large local inputs cannot starve its heartbeat.
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
            deadlineAt:
              this.config.providerStartDeadlineAt === undefined
                ? this.config.providerSessionDeadlineAt
                : this.config.providerSessionDeadlineAt === undefined
                  ? this.config.providerStartDeadlineAt
                  : Math.min(
                      this.config.providerStartDeadlineAt,
                      this.config.providerSessionDeadlineAt,
                    ),
            onLeaseLost: (error) => {
              this.admissionFailure ??= error;
              this.initiateAbort('lease_lost');
            },
          });

    const assertProviderStartAllowed = (phase: string) => {
      permit?.assertProviderStartAllowed();
      if (this.admissionFailure) throw this.admissionFailure;
      if (this.abortController.signal.aborted) {
        // Caller cancellation and the ordinary model timer are not admission
        // failures; keep them plain so they cannot manufacture provider_admission
        // truth before an attempt row exists.
        throw new Error(`provider attempt aborted ${phase}`);
      }
      if (
        this.config.providerStartDeadlineAt !== undefined &&
        Date.now() >= this.config.providerStartDeadlineAt
      ) {
        throw new ProviderSessionAdmissionError({
          reason: 'wait_timeout',
          laneId: this.resolved.provider,
          taskRunId: this.taskRunId,
          cause: new Error(`provider retry start window elapsed ${phase}`),
        });
      }
      if (
        this.config.providerSessionDeadlineAt !== undefined &&
        Date.now() >= this.config.providerSessionDeadlineAt
      ) {
        this.initiateAbort('session_deadline');
        throw new ProviderSessionWallClockBudgetError(phase);
      }
    };

    const assertProviderSessionCompletionAllowed = () => {
      // Recheck lease and cancellation after the iterator finishes: cooperative
      // abort is not proof the provider stopped. providerStartDeadlineAt is not
      // rechecked — it only gates beginning a retry, never a query in flight.
      permit?.assertProviderStartAllowed();
      if (this.admissionFailure) throw this.admissionFailure;
      const sessionDeadlineElapsed =
        this.config.providerSessionDeadlineAt !== undefined &&
        Date.now() >= this.config.providerSessionDeadlineAt;
      if (sessionDeadlineElapsed) this.initiateAbort('session_deadline');
      if (this.abortController.signal.aborted) {
        // Ordinary model budget or caller cancellation, not a control-plane
        // failure; a plain error keeps budget_timeout truth.
        throw sessionDeadlineElapsed
          ? new ProviderSessionWallClockBudgetError('during query')
          : new Error('provider attempt aborted during query');
      }
    };

    let outcome: { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
    try {
      assertProviderStartAllowed('before adapter startup');
      await execution.prepare();
      // Adapter startup performs the tool-mount/connect handshake but submits no
      // prompt. Keep that cold-start work inside the admission slot.
      assertProviderStartAllowed('during adapter startup');
      await permit?.completeStartup();
      assertProviderStartAllowed('after startup lease transition');
      await this.startWithInputHash(inputHash);
      // Admission can return inside the retry window while the durable start write
      // blocks past it; recheck at the final pre-prompt seam.
      assertProviderStartAllowed('during durable start');
      this.armExecutionTimer();
      assertProviderStartAllowed('before provider query');
      const value = await execution.run();
      assertProviderSessionCompletionAllowed();
      outcome = { status: 'fulfilled', value };
    } catch (error) {
      outcome = { status: 'rejected', reason: this.admissionFailure ?? error };
    }

    this.clearExecutionTimer();
    try {
      await execution.close();
    } catch (error) {
      // Cleanup is best-effort and must not overwrite provider/admission truth.
      console.warn(`[${this.config.logScope}] provider session cleanup failed`, {
        task_run_id: this.taskRunId,
        kind: this.kind,
        err: error,
      });
    }
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
    // The registry map's value type is the union of every spec's inferred literal
    // shape; read optional declared fields through this interface view.
    const declaredDef: TaskDefinition = tasks[this.kind];
    try {
      await writeAiTaskRunStarted(this.config.db, {
        id: this.taskRunId,
        task_kind: this.kind,
        provider: this.resolved.provider,
        model: this.resolved.model,
        input_hash: inputHash,
        ...(this.config.compiledPromptProvenance ?? {}),
        started_at: new Date(),
      });
      this.durableStart = true;
      this.trace?.metadata({ task_run_id: this.taskRunId, durable_settled: false });
      // YUK-924 P2 — record the profile source and the wired reasoning effort on
      // the same event channel as the lifecycle's other run events.
      console.info(`[${this.config.logScope}] model_profile_resolved`, {
        event: 'model_profile_resolved',
        task_run_id: this.taskRunId,
        kind: this.kind,
        provider: this.resolved.provider,
        model: this.resolved.model,
        profile_source: this.modelProfile.source,
        reasoning_effort: this.config.modelBinding?.effort ?? declaredDef.reasoningEffort ?? null,
        // YUK-1547 — native reasoning params (verbatim wire passthrough; null = none).
        native_reasoning_params: this.resolved.nativeReasoningParams ?? null,
        // YUK-1547 — which config layer produced this binding, frozen at resolution.
        selection_rule: this.resolved.selectionRule ?? null,
        // YUK-921 §2.1 — adapter selection stays observable. 'pi' is the only legal
        // adapter id; YUK-1049 typed tasks report 'typed'.
        execution_adapter:
          this.config.modelBinding?.adapter ??
          ((declaredDef as { execution?: string }).execution === 'typed' ? 'typed' : 'pi'),
        profile_effort_default: this.modelProfile.reasoning.defaultEffort ?? null,
      });
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
    this.observedUsage = terminal;
    this.costTruthCache = resolveAttemptCostTruth({
      provider: this.resolved.provider,
      model: this.resolved.model,
      tokens: terminal.tokenCounts,
      tokensObserved: terminal.tokenUsageObserved,
      reportedCostUsd: terminal.costUsd,
    });
  }

  /**
   * Keep the latest aggregate usage even when no terminal result arrives (budget
   * aborts still contribute the assistant turns observed before the cut).
   */
  recordObservedUsage(observation: ObservedRunUsage): void {
    if (this.terminal) return;
    this.observedUsage = observation;
    this.costTruthCache = undefined;
  }

  async recordToolCall(input: {
    toolName: string;
    inputJson: Record<string, unknown>;
    outputJson?: Record<string, unknown>;
    /** YUK-1547 — structured-submit evidence on a failed call. */
    errorReason?: string;
    iteration: number;
    latencyMs: number;
  }): Promise<void> {
    try {
      await writeToolCallLog(this.config.db, {
        task_run_id: this.taskRunId,
        task_kind: this.kind,
        tool_name: input.toolName,
        input_json: input.inputJson,
        output_json: input.outputJson ?? {},
        error_reason: input.errorReason,
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

    this.traceOutcome = 'success';
    this.trace?.metadata({ execution_outcome: 'success', durable_settled: true });

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
    this.traceOutcome = this.aborted ? 'cancelled' : 'error';
    this.trace?.metadata({ execution_outcome: this.traceOutcome, durable_settled: settled });
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
    this.trace?.metadata(() => {
      const evidence = this.terminal ?? this.observedUsage;
      const observed =
        evidence?.tokenUsageObserved === true ||
        this.usage.inputTokens > 0 ||
        this.usage.outputTokens > 0;
      return {
        usage_observed: observed,
        cost_basis: this.costBasis,
        cost_ref: this.costRef,
        aggregate_input_tokens: observed ? this.usage.inputTokens : undefined,
        aggregate_output_tokens: observed ? this.usage.outputTokens : undefined,
        aggregate_cost_usd: this.costUsd,
      };
    });
    this.trace?.end(this.aborted ? 'cancelled' : this.traceOutcome);
  }

  abort(): void {
    this.clearExecutionTimer();
    this.initiateAbort('lifecycle_abort');
  }

  private armExecutionTimer(): void {
    if (this.timer) return;
    const deadlineRemainingMs =
      this.config.providerSessionDeadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, this.config.providerSessionDeadlineAt - Date.now());
    const timeoutMs = Math.min(this.config.timeoutMs, deadlineRemainingMs);
    // Name the initiator by which bound actually governs the armed timer.
    const timeoutInitiator: TransportAbortInitiator =
      deadlineRemainingMs < this.config.timeoutMs ? 'session_deadline' : 'execution_timeout';
    if (timeoutMs <= 0) {
      this.initiateAbort(timeoutInitiator);
      return;
    }
    // Unbounded window: setTimeout(Infinity) degenerates to ~1ms and would abort
    // the run instantly.
    if (!Number.isFinite(timeoutMs)) return;
    this.transportEvidence.noteExecutionTimeoutMs(timeoutMs);
    this.timer = setTimeout(() => this.initiateAbort(timeoutInitiator), timeoutMs);
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

    // A failed success projection may be downgraded exactly once to failure. Never
    // retry an ambiguous status, upgrade failure to success, or allow concurrent
    // terminal transactions; the DB's CAS and unique ledger remain the last guards.
    if (this.terminalWriteAttempts.size > 0 && input.status !== 'failure') return false;
    this.terminalWriteAttempts.add(input.status);
    this.terminalWriteInFlight = true;
    this.sealHelpLatency(input.status);
    if (this.notePhases) {
      console.info(`[${this.config.logScope}] note_generate_model_phases`, {
        event: 'note_generate_model_phases',
        task_run_id: this.taskRunId,
        kind: this.kind,
        phases: this.notePhases,
        usage_basis: this.usage.usage_basis ?? 'reported',
      });
    }
    try {
      const settled = await writeAiTaskAttemptFinished(this.config.db, {
        id: this.taskRunId,
        status: input.status,
        finish_reason: input.finishReason,
        usage: this.persistedUsage,
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
  // YUK-1013 — a per-run binding pins routing exactly like ctx.override does;
  // retry stays off on pinned lanes (single-transient-layer principle).
  if (ctx.modelBinding?.provider || ctx.modelBinding?.model) return false;
  if (hasGlobalProviderOverride()) return false;
  return true;
}

export function maxLifecycleAttempts(transientRetries: number, ctx: LifecycleRetryContext): number {
  return 1 + (transientRetryEnabled(ctx) ? transientRetries : 0);
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
