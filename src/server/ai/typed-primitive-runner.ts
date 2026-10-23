// YUK-1049 — restricted TYPED execution entry (OpenRouter native decisions
// endpoint → AiRunLifecycle). A dedicated typed sibling seam, not the chat
// façade: the wire carries {state, questions} typed primitives, never a prompt.
//
// The request model is pinned (drift = contract violation), provider constraints
// stay TypeSafe-only with allow_fallbacks=false, and usage/cost/confidence are
// optional — never fabricated. The Jev→advanced upgrade is the CALLER's separate
// invocation inside the same wall-clock deadline, so the bound covers both lanes.
//
// Lifecycle reuse (spec §5.2 — do not fork): admission, cancellation, timeout,
// durable rows, retry taxonomy and cost truth come from AiRunLifecycle; the
// canonical typed body is what gets hashed into ai_task_runs.input_hash.
//
// The registry's budget.maxCost has no runtime consumer (the SDK-era maxBudgetUsd
// wiring is gone), so this runner enforces the cap itself: a reserve is charged
// before each wire attempt and unknown cost counts as the reserve.

import type { ZodTypeAny } from 'zod';
import { AgentRunError, RETRY_ELAPSED_CAP_MS, isTransientAgentFailure } from '@/ai/agent-run-error';
import type { LifecycleResult, AiTaskUsage as LifecycleUsage } from '@/ai/task-result';
import type { TaskDefinition } from '@/ai/task-spec';
import { type TaskKind, resolveTaskBudget, tasks } from '@/capabilities/task-registry';
import { JevScoringDecisionInput, JevSystemOneResponse } from '@/core/schema/jev-systemone';
import type { Db } from '@/db/client';
import { bindAgentRunError } from './agent-run-error';
import type { AttemptCostBasis } from './attempt-cost';
import { JEV_CANONICAL_MODEL, JEV_MAX_PRICE_USD_PER_MILLION } from './pricing';
import { classifyLifecycleRetry, createRunLifecycle } from './run-lifecycle';
import { emptyStreamTextStats } from './timeout-usage';

/** Worst-case USD reserved per wire attempt when the endpoint's own cost truth is absent. */
export const TYPED_RESERVE_PER_CALL_USD = 0.005;
/** The actual typed transport provider, shared by execution and read-only facts. */
const TYPED_PRIMITIVE_PROVIDER = 'openrouter' as const;
/** TypeSafe is the only provider ever allowed to serve this lane. */
export const TYPESAFE_PROVIDER_CONSTRAINTS = {
  only: ['TypeSafe'],
  order: ['TypeSafe'],
  allow_fallbacks: false,
  max_price: JEV_MAX_PRICE_USD_PER_MILLION,
} as const;

interface RegisteredTypedTask {
  readonly inputSchema: ZodTypeAny;
  readonly outputSchema: ZodTypeAny;
  readonly endpointPath: string;
  /** Pinned canonical response model; drift ⇒ typed_contract_violation. */
  readonly expectedModel: string;
  /** Pinned response provider tag when the wire carries one. */
  readonly expectedProvider?: string;
  readonly providerConstraints: Record<string, unknown>;
}

/**
 * The ONLY tasks this runner will ever execute — a discriminated typed-task
 * registry, not a general HTTP proxy or a dynamic task endpoint (grounding
 * §5.1). Adding a typed task requires a catalog TypedTaskSpec (execution:
 * 'typed') AND an entry here; both halves must exist.
 */
const TYPED_TASKS: Record<string, RegisteredTypedTask> = {
  JevScoringDecisionTask: {
    inputSchema: JevScoringDecisionInput,
    outputSchema: JevSystemOneResponse,
    endpointPath: 'systemone',
    expectedModel: JEV_CANONICAL_MODEL,
    expectedProvider: 'TypeSafe',
    providerConstraints: TYPESAFE_PROVIDER_CONSTRAINTS,
  },
};

export function isRegisteredTypedTask(kind: string): kind is TaskKind {
  return Object.hasOwn(TYPED_TASKS, kind);
}

/** Registered executable bindings only; never infer typed support from chat routing. */
export function registeredTypedTaskBindings() {
  return Object.keys(TYPED_TASKS)
    .filter(isRegisteredTypedTask)
    .filter((kind) => (tasks[kind] as TaskDefinition).execution === 'typed')
    .map((kind) => ({ kind, provider: TYPED_PRIMITIVE_PROVIDER, model: tasks[kind].defaultModel }));
}

export interface TypedPrimitiveCtx {
  readonly db: Db;
  /** Caller-pinned attempt-1 run id (idempotent replays). */
  readonly taskRunId?: string;
  /** Caller cancellation — aborts transport and lifecycle timer. */
  readonly signal?: AbortSignal;
  /** Shared in-process tool abort lineage (as runTask). */
  readonly abortController?: AbortController;
  /**
   * Absolute wall-clock bound (ms epoch) covering admission, retries and the
   * caller's application-layer fallback. The runner takes the min with its own
   * runTask-style session bound, so both lanes share one budget.
   */
  readonly deadlineAt?: number;
  readonly parentTaskRunId?: string;
  /** Test seam: replace ONLY the wire transport (never the lifecycle). */
  readonly fetchImpl?: typeof fetch;
  readonly logScope?: string;
  readonly retry?: 'none';
}

export interface TypedPrimitiveOutcome<Output = unknown> {
  readonly task_run_id: string;
  readonly output: Output;
  readonly attempts: number;
  readonly usage: LifecycleUsage;
  /**
   * Cumulative settled/reserved cost of THIS invocation — earlier failed wire
   * attempts plus the terminal one (unknown cost counts as the reserve, never
   * zero). Spend gates must use this, not the last attempt alone.
   */
  readonly cost_usd: number;
  /** Cost basis of the SUCCEEDING attempt (cumulative unknown-ness rides on `unknown_cost`). */
  readonly cost_basis: AttemptCostBasis;
  readonly cost_ref: string;
  readonly model: string;
  /** True when any settled attempt's cost is unknown (reserved, not zeroed). */
  readonly unknown_cost: boolean;
}

function typedContractViolation(kind: string, taskRunId: string, detail: string): AgentRunError {
  return new AgentRunError({
    kind,
    taskRunId,
    subtype: 'typed_contract_violation',
    errors: [detail],
  });
}

const ERROR_SNIPPET_MAX = 500;

/**
 * Execute one registered typed task end-to-end: admission → canonical body →
 * systemone POST → schema-parsed output → durable cost/provenance.
 *
 * Retry taxonomy: non-transient 4xx are PERMANENT (no blind retry); 429/529/5xx
 * and connection-class failures retry only inside the shared wall-clock bound,
 * at most budget.transientRetries extra wire calls.
 */
export async function runTypedPrimitiveTask<Output = unknown>(
  kind: string,
  input: unknown,
  ctx: TypedPrimitiveCtx,
): Promise<TypedPrimitiveOutcome<Output>> {
  const registration = TYPED_TASKS[kind];
  if (!registration || !isRegisteredTypedTask(kind)) {
    throw new Error(
      `typed primitive runner: unregistered task '${kind}' — typed execution only accepts tasks in the typed registry (typed-primitive-runner.ts)`,
    );
  }
  // Literal-union read through the declared interface view.
  const def = tasks[kind] as TaskDefinition;
  if ((def.execution ?? 'chat') !== 'typed') {
    throw new Error(`typed primitive runner: '${kind}' is not a typed-execution task`);
  }
  const budget = resolveTaskBudget(kind);
  // A parse failure is a caller contract bug, thrown before any lifecycle/cost work.
  const parsedInput = registration.inputSchema.parse(input);

  // Pin model + provider constraints here so a caller cannot weaken them; the
  // input_hash over this body is the typed provenance fingerprint.
  const body = {
    model: def.defaultModel,
    provider: registration.providerConstraints,
    ...(parsedInput as Record<string, unknown>),
  };

  const maxAttempts = ctx.retry === 'none' ? 1 : 1 + budget.transientRetries;
  const reserveUsd = TYPED_RESERVE_PER_CALL_USD;
  const maxCostUsd = budget.maxCost;
  const firstAttemptStartedAt = Date.now();
  // runTask parity: the session bound covers retries inside one wall clock; the
  // caller deadline also bounds the application-layer fallback.
  const retryingDeadlineAt =
    maxAttempts > 1 ? firstAttemptStartedAt + RETRY_ELAPSED_CAP_MS + budget.timeout : undefined;
  const providerSessionDeadlineAt =
    ctx.deadlineAt === undefined
      ? retryingDeadlineAt
      : retryingDeadlineAt === undefined
        ? ctx.deadlineAt
        : Math.min(ctx.deadlineAt, retryingDeadlineAt);

  let spentUsd = 0;
  let unknownCost = false;
  let lastErr: unknown;
  let retrySource: ReturnType<typeof createRunLifecycle> | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Cumulative maxCost gate — the typed path's own enforcement. Unknown-cost
    // attempts were accounted at the reserve, so the bound is conservative.
    if (spentUsd + reserveUsd > maxCostUsd) {
      throw (
        lastErr ??
        new AgentRunError({
          kind,
          taskRunId: ctx.taskRunId ?? 'pre-attempt',
          subtype: 'runner_error',
          errors: [
            `typed run cumulative cost cap reached (${spentUsd}+${reserveUsd} reserve > ${maxCostUsd} maxCost)`,
          ],
        })
      );
    }
    const lifecycle = createRunLifecycle<LifecycleResult>({
      db: ctx.db,
      kind,
      timeoutMs: budget.timeout,
      abortController: ctx.abortController,
      // Pin provider+model: a global AI_PROVIDER_OVERRIDE must never redirect the
      // typed lane, and the model pin is the verified request id, not an alias.
      override: { provider: TYPED_PRIMITIVE_PROVIDER, model: def.defaultModel },
      parentTaskRunId: ctx.parentTaskRunId,
      providerStartDeadlineAt:
        retrySource !== undefined ? firstAttemptStartedAt + RETRY_ELAPSED_CAP_MS : undefined,
      providerSessionDeadlineAt,
      taskRunId: attempt === 1 ? ctx.taskRunId : undefined,
      signal: ctx.signal,
      logScope: ctx.logScope ?? 'typedPrimitive',
    });
    let wireAttempted = false;
    let endpointUrl: string;
    try {
      const output = await lifecycle.withProviderSession(body, {
        async prepare() {
          if (lifecycle.resolved.authMode !== 'key' || !lifecycle.resolved.baseUrl)
            throw new Error('Typed model catalog endpoint is unknown');
          endpointUrl = `${lifecycle.resolved.baseUrl}/${registration.endpointPath}`;
        },
        async run() {
          await retrySource?.markRetried();
          retrySource = undefined;
          const transport = ctx.fetchImpl ?? fetch;
          wireAttempted = true;
          let response: Response;
          try {
            response = await transport(endpointUrl, {
              method: 'POST',
              redirect: 'error',
              headers: {
                Authorization: `Bearer ${lifecycle.resolved.apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
              signal: lifecycle.abortController.signal,
            });
          } catch (error) {
            if (lifecycle.abortController.signal.aborted) throw error;
            // Connection-class failure before an HTTP status — the probe-frozen
            // transient marker (api_error_status null).
            throw new AgentRunError({
              kind,
              taskRunId: lifecycle.taskRunId,
              subtype: 'api_error_result',
              apiErrorStatus: null,
              errors: [error instanceof Error ? error.message : String(error)],
            });
          }
          const text = await response.text();
          if (!response.ok) {
            // Non-transient statuses are permanent; isTransientAgentFailure
            // whitelists only null/429/5xx. No blind retry.
            throw new AgentRunError({
              kind,
              taskRunId: lifecycle.taskRunId,
              subtype: 'api_error_result',
              apiErrorStatus: response.status,
              errors: [text.slice(0, ERROR_SNIPPET_MAX)],
            });
          }
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            throw typedContractViolation(kind, lifecycle.taskRunId, 'response body is not JSON');
          }
          const parsed = registration.outputSchema.safeParse(json);
          if (!parsed.success) {
            throw typedContractViolation(
              kind,
              lifecycle.taskRunId,
              `response schema mismatch: ${parsed.error.issues
                .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                .join('; ')
                .slice(0, ERROR_SNIPPET_MAX)}`,
            );
          }
          const output = parsed.data as {
            model?: string;
            provider?: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cost?: number;
            };
          };
          if (output.model !== registration.expectedModel) {
            throw typedContractViolation(
              kind,
              lifecycle.taskRunId,
              `model drift: response model '${output.model}' != pinned canonical '${registration.expectedModel}'`,
            );
          }
          if (
            registration.expectedProvider !== undefined &&
            output.provider !== undefined &&
            output.provider !== registration.expectedProvider
          ) {
            throw typedContractViolation(
              kind,
              lifecycle.taskRunId,
              `provider drift: response provider '${output.provider}' != '${registration.expectedProvider}'`,
            );
          }
          const usage = output.usage;
          lifecycle.recordTerminalResult({
            usage: {
              inputTokens: usage?.input_tokens ?? 0,
              outputTokens: usage?.output_tokens ?? 0,
            },
            numTurns: 1,
            tokenCounts: {
              inputTokens: usage?.input_tokens ?? 0,
              outputTokens: usage?.output_tokens ?? 0,
            },
            costUsd: usage?.cost,
            finishReason: 'typed_terminal',
          });
          return output;
        },
        async close() {},
      });

      const result: LifecycleResult = {
        task_run_id: lifecycle.taskRunId,
        text: JSON.stringify(output),
        finishReason: lifecycle.finishReason,
        usage: lifecycle.usage,
        cost_usd: lifecycle.costUsd,
        cost_basis: lifecycle.costBasis,
        cost_ref: lifecycle.costRef,
        structured_output: output,
      };
      await lifecycle.finishSuccess(result);
      // YUK-1092 — report CUMULATIVE invocation spend: earlier settled attempts plus
      // this one (unknown ⇒ the reserve, never zero). Last-attempt-only reporting
      // undercounts and can blow plan-level max_total_cost bounds after retries.
      const successSettledUsd = result.cost_usd ?? reserveUsd;
      spentUsd += successSettledUsd;
      return {
        task_run_id: lifecycle.taskRunId,
        output: output as Output,
        attempts: attempt,
        usage: result.usage,
        cost_usd: spentUsd,
        cost_basis: result.cost_basis,
        cost_ref: result.cost_ref,
        model: def.defaultModel,
        unknown_cost: unknownCost || result.cost_basis === 'unknown',
      };
    } catch (error) {
      // A wire call that may have reached the provider contributes its settled
      // truth — unknown ⇒ reserve, never zero.
      if (wireAttempted || lifecycle.costBasis !== 'unknown') {
        spentUsd += lifecycle.costUsd ?? reserveUsd;
        if (lifecycle.costBasis === 'unknown') unknownCost = true;
      }
      if (!lifecycle.started) throw error;
      await lifecycle.recordEstimatedUsage({
        promptText: JSON.stringify(body),
        output: emptyStreamTextStats(),
        priceOrigin: 'failure-estimate',
      });
      const boundError = bindAgentRunError({
        error,
        kind,
        taskRunId: lifecycle.taskRunId,
        aborted: lifecycle.aborted,
      });
      lastErr = boundError;
      const settled = await lifecycle.finishFailure(boundError, 'error');
      if (!settled) throw boundError;
      const retry = classifyLifecycleRetry({
        attempt,
        maxAttempts,
        firstAttemptStartedAt,
        error: boundError,
      });
      if (!retry.willRetry) throw boundError;
      retrySource = lifecycle;
      console.warn('[typedPrimitive] task_run_transient_retry', {
        event: 'task_run_transient_retry',
        kind,
        task_run_id: lifecycle.taskRunId,
        attempt,
        elapsed_ms: retry.elapsedMs,
      });
    } finally {
      lifecycle.dispose();
    }
  }
  throw lastErr;
}

/** Narrow predicate: does this error end the Jev lane for this invocation? */
export function isTypedPermanentFailure(error: unknown): boolean {
  return error instanceof AgentRunError && !isTransientAgentFailure(error);
}
