// Per-attempt startup assembly shared by runTask / streamTask /
// streamTaskCollecting: the call spec (buildQueryOptions) and the
// agent-workspace mount injected on every tool-loop task. Keeping this out of
// runner.ts keeps the single adapter seam thin — the runner owns lifecycle,
// this module owns what the attempt presents to the adapter.

import { type PiToolMount, piDomainMount } from '@/ai/pi-tool-mount';
import type { TaskBudget, TaskDefinition } from '@/ai/task-spec';
import { type TaskKind, getTaskSystemPrompt, tasks } from '@/capabilities/task-registry';
import {
  AGENT_WORKSPACE_DOMAIN_TOOLS,
  DOMAIN_TOOL_MCP_SERVER_NAME,
  toMcpAllowedToolName,
} from '@/kernel/tools/allowlists';
import { providerHttpTimeoutMs } from './provider-http-timeout';
import type { ProviderTransportCollector } from './provider-transport';
import type { ResolvedProvider } from './providers';
import type { RunTaskCtx } from './runner-context';
import type { Options } from './sdk-types';
import { currentTaskSpendScope } from './task-spend-scope';

/**
 * Build the per-attempt call spec for the adapter so the three entry points stay
 * consistent on tools-from-registry default, turn ceiling and session resume.
 * The pi surfaces live on `ctx.pi*` and are read by the adapter, not here.
 */
export function buildQueryOptions(
  kind: TaskKind,
  ctx: RunTaskCtx,
  abortController: AbortController,
  // The caller resolves ONCE per attempt and threads the binding in (YUK-576):
  // single resolution per attempt keeps the retry loop's env/model provably
  // per-attempt-consistent.
  resolved: ResolvedProvider,
  budget: TaskBudget,
  transportEvidence?: ProviderTransportCollector,
): Options {
  // Read optional fields through the shared definition interface.
  const def = tasks[kind];
  const declaredDef: TaskDefinition = def;
  const options: Options = {
    judgeRetryPolicy: ctx.judgeRetryPolicy,
    model: resolved.model,
    systemPrompt: getTaskSystemPrompt(kind, ctx.subjectProfile, ctx.learnerLocale),
    abortController,
    tools: ctx.allowedTools ?? def.allowedTools,
    maxTurns: budget.maxIterations === 'unbounded' ? undefined : budget.maxIterations || 1,
    // Keep the HTTP timers behind the task lifecycle timeout.
    providerTimeoutMs: providerHttpTimeoutMs(budget.timeout),
    transportEvidence,
    ...(declaredDef.enforceMaxCost === true ||
    declaredDef.structuredOutputMode === 'tool' ||
    currentTaskSpendScope()
      ? { maxBudgetUsd: budget.maxCost }
      : {}),
  };
  // YUK-923 — per-run modelBinding effort wins over the task-kind declaration.
  const reasoningEffort = ctx.modelBinding?.effort ?? declaredDef.reasoningEffort;
  if (reasoningEffort !== undefined) {
    options.effort = reasoningEffort;
  }
  if (ctx.sdkSession?.persist && ctx.sdkSession.resume) {
    options.resume = ctx.sdkSession.resume;
  }
  return options;
}

/**
 * Every tool-loop task rides with the agent-workspace mount unless the caller
 * explicitly pinned an empty runtime allowlist (authoritativeReply turns keep
 * their zero-tool contract). A spec-level `allowedTools: []` means "no domain
 * business tools", not "no sandbox" — the sandbox pair is still appended for
 * judges and other tool-less specs, as the owner decision requires.
 */
export function workspaceInjectedExecution(
  ctx: RunTaskCtx | undefined,
  kind: TaskKind,
  options: Options,
): { mounts: PiToolMount[] | undefined; options: Options } {
  if (!ctx || (ctx.allowedTools !== undefined && ctx.allowedTools.length === 0))
    return { mounts: ctx?.piToolMounts, options };
  const mount = piDomainMount({
    ctx: {
      db: ctx.db,
      // taskRunId here is the workspace owner key: the caller-anchored logical
      // id when supplied; when empty the tool falls back to the attempt's
      // logTaskRunId, so each attempt gets a bound directory either way.
      taskRunId: ctx.taskRunId ?? '',
      sessionId: ctx.sessionId,
      callerActor: { kind: 'agent', ref: `agent:${kind}` },
      signal: ctx.signal,
    },
    serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
    toolNames: AGENT_WORKSPACE_DOMAIN_TOOLS,
    taskKind: kind,
  });
  const extraTools = AGENT_WORKSPACE_DOMAIN_TOOLS.map((name) => toMcpAllowedToolName(name));
  return {
    mounts: [...(ctx.piToolMounts ?? []), mount],
    options:
      options.tools === undefined
        ? options
        : { ...options, tools: [...new Set([...options.tools, ...extraTools])] },
  };
}
