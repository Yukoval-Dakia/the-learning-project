// YUK-1049 — restricted TYPED execution entry (OpenRouter native decisions
// endpoint → AiRunLifecycle). Grounding §5: a dedicated typed sibling seam,
// NOT the chat façade — POST /api/v1/systemone carries {state, questions}
// typed primitives, never a composed prompt.
//
// Contract (D12 smoke FINAL 2026-09-24 — wire/auth/cost only, no accuracy):
//   - pinned request model typesafe/jev-1.13 → canonical response model
//     typesafe/jev-1.13-20260917 (drift = contract violation);
//   - provider constraints only+order ['TypeSafe'], allow_fallbacks=false,
//     max_price {prompt 0.042, completion 0} USD/M;
//   - Jev→advanced upgrade happens at the APPLICATION layer (the caller —
//     jev-model-executor.ts) as a SEPARATE invocation inside the same
//     wall-clock deadline; OR has no models-array fallback for this wire;
//   - usage/cost/probabilities/confidence are OPTIONAL — never fabricated;
//   - confidence is distribution shape, not accuracy.
//
// Lifecycle reuse (spec §5.2 — do not fork): admission / cancellation /
// timeout / durable started+terminal rows / retry taxonomy / cost truth /
// input provenance all come from AiRunLifecycle + resolveTaskProvider. The
// canonical typed body (state+questions+model+provider constraints) is what
// withProviderSession hashes into ai_task_runs.input_hash — the provenance
// fingerprint; compiledPromptProvenance is NOT set (that field is the
// chat-prompt channel).
//
// Budget honesty (spec §5.2 warning verified in source): the registry's
// budget.maxCost has NO runtime consumer today — the SDK maxBudgetUsd wiring
// died with Adapter A (src/kernel/tools/budgets.ts). This runner therefore
// enforces the cap itself: a per-call reserve (default $0.005, the D12 smoke
// reserve) is charged BEFORE each wire attempt, and settled attempts account
// their truth (unknown cost counts as the reserve — never zero).

import type { ZodTypeAny } from 'zod';
import { type TaskKind, tasks } from '@/ai/registry';
import type { TaskDefinition } from '@/ai/task-spec';
import { JevScoringDecisionInput, JevSystemOneResponse } from '@/core/schema/jev-systemone';
import type { Db } from '@/db/client';
import {
  AgentRunError,
  RETRY_ELAPSED_CAP_MS,
  bindAgentRunError,
  isTransientAgentFailure,
} from './agent-run-error';
import type { AttemptCostBasis } from './attempt-cost';
import { JEV_CANONICAL_MODEL, JEV_MAX_PRICE_USD_PER_MILLION } from './pricing';
import {
  type LifecycleResult,
  type LifecycleUsage,
  classifyLifecycleRetry,
  createRunLifecycle,
} from './run-lifecycle';

/** Worst-case USD reserved per wire attempt when the endpoint's own cost truth is absent. */
export const TYPED_RESERVE_PER_CALL_USD = 0.005;
/** Native typed decisions endpoint — NOT the chat completions façade. */
export const SYSTEMONE_ENDPOINT_URL = 'https://openrouter.ai/api/v1/systemone';
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
  readonly endpointUrl: string;
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
    endpointUrl: SYSTEMONE_ENDPOINT_URL,
    expectedModel: JEV_CANONICAL_MODEL,
    expectedProvider: 'TypeSafe',
    providerConstraints: TYPESAFE_PROVIDER_CONSTRAINTS,
  },
};

export function isRegisteredTypedTask(kind: string): kind is TaskKind {
  return Object.hasOwn(TYPED_TASKS, kind);
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
   * Absolute wall-clock bound (ms epoch) covering admission, retries AND the
   * caller's application-layer advanced fallback. The runner computes the
   * same runTask-style internal session bound (first start + retry cap + one
   * attempt timeout) and takes the min — the caller uses the SAME deadlineAt
   * for its escalation invocation, so the total budget spans both lanes.
   */
  readonly deadlineAt?: number;
  readonly parentTaskRunId?: string;
  /** Test seam: replace ONLY the wire transport (never the lifecycle). */
  readonly fetchImpl?: typeof fetch;
  readonly logScope?: string;
}

export interface TypedPrimitiveOutcome<Output = unknown> {
  readonly task_run_id: string;
  readonly output: Output;
  readonly attempts: number;
  readonly usage: LifecycleUsage;
  /**
   * Cumulative settled/reserved cost of THIS invocation — every prior
   * wire-attempted failure plus the terminal success attempt (unknown cost
   * counts as the per-call reserve, never zero — YUK-1092). Consumers
   * (cost_usd_micros reporting, plan-level spend gates) must use this
   * cumulative figure, not the last attempt alone.
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
 * systemone POST → schema-parsed typed output → durable cost/provenance.
 *
 * Retry taxonomy (spec §5.2): 401/422 (and every non-transient 4xx) are
 * PERMANENT — no blind retry; 429/529/5xx and connection-class transport
 * failures retry only inside the shared wall-clock bound (RETRY_ELAPSED_CAP_MS
 * start gate + session deadline), never multiplied by SDK/queue retries —
 * this path performs at most def.budget.transientRetries extra wire calls.
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
  // Literal-union read through the declared interface view (same pattern as
  // run-lifecycle.ts TaskDefinition reads).
  const def = tasks[kind] as TaskDefinition;
  if ((def.execution ?? 'chat') !== 'typed') {
    throw new Error(`typed primitive runner: '${kind}' is not a typed-execution task`);
  }
  // Input is schema-parsed directly — a failure is a caller contract bug,
  // thrown BEFORE any lifecycle/admission/cost work exists (no task_run row).
  const parsedInput = registration.inputSchema.parse(input);

  // Canonical typed body: model + provider constraints are pinned here so a
  // caller cannot weaken them (allow_fallbacks stays false, TypeSafe stays
  // the only provider, max_price stays bounded). The input_hash over THIS
  // body is the typed provenance fingerprint (spec §5.2).
  const body = {
    model: def.defaultModel,
    provider: registration.providerConstraints,
    ...(parsedInput as Record<string, unknown>),
  };

  const maxAttempts = 1 + def.budget.transientRetries;
  const reserveUsd = TYPED_RESERVE_PER_CALL_USD;
  const maxCostUsd = def.budget.maxCost;
  const firstAttemptStartedAt = Date.now();
  // runTask parity: the in-process session bound covers retries inside one
  // wall clock; the caller deadline bounds the whole invocation INCLUDING the
  // application-layer advanced fallback.
  const retryingDeadlineAt =
    maxAttempts > 1 ? firstAttemptStartedAt + RETRY_ELAPSED_CAP_MS + def.budget.timeout : undefined;
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
    // Cumulative maxCost gate — the typed path's own budget enforcement
    // (verified absent elsewhere). Unknown-cost attempts were accounted at
    // the reserve, so the bound is conservative, never optimistic.
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
      timeoutMs: def.budget.timeout,
      abortController: ctx.abortController,
      // Pin provider+model explicitly: a global AI_PROVIDER_OVERRIDE must never
      // redirect the typed lane onto a chat-incompatible provider, and the
      // model pin is the verified request id, not an alias (spec §5.2).
      override: { provider: 'openrouter', model: def.defaultModel },
      parentTaskRunId: ctx.parentTaskRunId,
      providerStartDeadlineAt:
        retrySource !== undefined ? firstAttemptStartedAt + RETRY_ELAPSED_CAP_MS : undefined,
      providerSessionDeadlineAt,
      taskRunId: attempt === 1 ? ctx.taskRunId : undefined,
      signal: ctx.signal,
      logScope: ctx.logScope ?? 'typedPrimitive',
    });
    let wireAttempted = false;
    try {
      const output = await lifecycle.withProviderSession(body, {
        async prepare() {
          // HTTP has no warm transport: the durable start row still lands
          // between this hook and run(), keeping admission/attempt ordering.
        },
        async run() {
          await retrySource?.markRetried();
          retrySource = undefined;
          const transport = ctx.fetchImpl ?? fetch;
          wireAttempted = true;
          let response: Response;
          try {
            response = await transport(registration.endpointUrl, {
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
            // Connection-class: DNS/socket/reset before an HTTP status —
            // the probe-frozen transient marker (api_error_status null).
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
            // Typed HTTP status map: 401/422 (and every other non-transient
            // status) → permanent api_error_result (isTransientAgentFailure
            // whitelists only null/429/5xx). No blind retry.
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
      // YUK-1092 — the reported cost is the CUMULATIVE invocation spend:
      // settled earlier attempts (failure branch charged them) + this
      // success attempt's truth (unknown ⇒ the reserve, never zero).
      // Reporting only the last attempt undercounts and lets callers blow
      // plan-level max_total_cost bounds after retries.
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
      // Reserve accounting: a wire call that may have reached the provider
      // contributes its settled truth — unknown ⇒ reserve, never zero.
      if (wireAttempted || lifecycle.costBasis !== 'unknown') {
        spentUsd += lifecycle.costUsd ?? reserveUsd;
        if (lifecycle.costBasis === 'unknown') unknownCost = true;
      }
      if (!lifecycle.started) throw error;
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
