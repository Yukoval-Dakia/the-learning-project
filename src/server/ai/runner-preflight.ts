import type { RunTaskResult } from '@/ai/task-result';
import { type TaskKind, getLearnerLocale, resolveTaskBudget } from '@/capabilities/task-registry';
import { resolveProviderSessionDeadlineAt } from '../http/provider-session-deadline';
import { resolveExecutionAdapter } from './execution-adapter';
import { PROVIDER_HTTP_TIMEOUT_MARGIN_MS } from './provider-http-timeout';
import { PROVIDER_SESSION_SDK_STARTUP_TIMEOUT_MS } from './provider-session-admission-policy';
import { createRunLifecycle } from './run-lifecycle';
import {
  type RunTaskCtx,
  assertChatExecutionKind,
  compiledPromptProvenance,
  isKnownTask,
} from './runner';
import { buildQueryOptions } from './runner-startup';
import { currentTaskSpendScope } from './task-spend-scope';

/**
 * Resolve and start the same adapter the real chat path would use, without
 * acquiring a provider session, writing the durable attempt, or submitting a
 * prompt. Callers use this as a pre-send lane check when a later paid step would
 * otherwise hide a stored-provider/model configuration failure behind spent work.
 */
export async function preflightTaskExecution(
  kind: TaskKind,
  input: unknown,
  initialCtx: RunTaskCtx,
): Promise<void> {
  const ctx = { ...initialCtx, learnerLocale: initialCtx.learnerLocale ?? getLearnerLocale() };
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  assertChatExecutionKind(kind);
  const scopedAllowance = currentTaskSpendScope()?.remainingUsd();
  const budget = resolveTaskBudget(kind, {
    ...ctx.budgetOverride,
    ...(scopedAllowance === undefined
      ? {}
      : {
          maxCost: Math.min(resolveTaskBudget(kind, ctx.budgetOverride).maxCost, scopedAllowance),
        }),
  });
  const modelBinding = ctx.modelBinding;
  const lifecycle = createRunLifecycle<RunTaskResult>({
    db: ctx.db,
    kind,
    timeoutMs: budget.timeout,
    timeoutSource: budget.timeoutSource,
    abortController: ctx.lifecycleAbortController,
    override: ctx.override,
    modelBinding,
    parentTaskRunId: ctx.parentTaskRunId,
    providerSessionDeadlineAt: resolveProviderSessionDeadlineAt(ctx.providerSessionDeadlineAt),
    taskRunId: ctx.taskRunId,
    signal: ctx.signal,
    logScope: 'preflightTaskExecution',
    compiledPromptProvenance: compiledPromptProvenance(ctx.compiledModelPrompt),
  });
  try {
    const adapter = resolveExecutionAdapter(modelBinding, lifecycle.resolved, lifecycle.kind);
    const callOptions = buildQueryOptions(
      kind,
      ctx,
      lifecycle.abortController,
      lifecycle.resolved,
      budget,
      lifecycle.transportEvidence,
    );
    const prepared = await adapter.startup({
      options: callOptions,
      initializeTimeoutMs: lifecycle.providerPhaseTimeoutMs(
        PROVIDER_SESSION_SDK_STARTUP_TIMEOUT_MS,
      ),
      resolved: lifecycle.resolved,
      runId: lifecycle.taskRunId,
      kind: lifecycle.kind,
      structuredSubmitInput: input,
      executionWindowMs: lifecycle.providerPhaseTimeoutMs(
        callOptions.providerTimeoutMs === undefined
          ? Number.POSITIVE_INFINITY
          : callOptions.providerTimeoutMs - PROVIDER_HTTP_TIMEOUT_MARGIN_MS,
      ),
      piToolMounts: ctx.piToolMounts,
      piHooks: ctx.piHooks,
      piSessionReplay: ctx.piSessionReplay,
      piSkillDocs: ctx.piSkillDocs,
      piAgents: ctx.piAgents,
      piQueues: ctx.piQueues,
      nativeCompaction: ctx.nativeCompaction,
    });
    await prepared.close();
  } finally {
    lifecycle.dispose();
  }
}
