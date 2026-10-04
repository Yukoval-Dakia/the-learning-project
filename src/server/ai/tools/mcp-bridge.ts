// YUK-81 + YUK-82 / Foundation D M1 Lane C + Lane D
//
// Generic bridge: wrap any DomainTool from the registry into an agent-visible
// MCP-named tool (`mcp__<server>__<tool>`). Replaces the per-task hand-written
// tool-builder pattern for any task that needs access to read / propose /
// write tools. YUK-1025 — the execution engine is pi-only; mounts compile to
// `AgentTool`s in pi-tools.ts over this shared pipeline.
//
// Each tool call:
//   1. zod-parse the raw args (re-parse for the typed Input value and a
//      stable error path).
//   2. execute the tool against the captured ToolContext.
//   3. write a tool_call_log row with effect + error_reason populated.
//   4. resolve mirrorEvent policy and, when it fires, write a `tool_use`
//      KnownEvent mirror with payload
//      { tool_name, args, result_summary, error_reason? } so Copilot /
//      Dreaming / Coach can replay tool history from the event log.
//      Lane D added this; ADR-0011 §1.1 (T-D7 / YUK-126) promoted the
//      former `experimental:tool_use` to KnownEvent `tool_use`
//      (`ToolUseQuery` in `src/core/schema/event/known.ts`).
//   5. return an MCP-shaped { content: [{ type: 'text', text: <json> }] }
//      result the LLM can read.

import { createId } from '@paralleldrive/cuid2';
import { writeEvent } from '@/kernel/events';
import {
  type ToolOperationRecord,
  type ToolOperations,
  executeSafeToolOperation,
  getProcessToolOperations,
} from '@/kernel/tools/tool-operations';
import type {
  DomainTool,
  ProposalEffectContract,
  ToolCallerActor,
  ToolContext,
  ToolEffect,
  ToolExecutionGateInput,
  ToolExecutionResultObservation,
  ToolMirrorPolicy,
} from '@/kernel/tools/types';
import { setToolCallLogMirroredEventId, writeToolCallLog } from '@/server/ai/log';
import { getTool } from './registry';

/**
 * Decide whether a tool invocation should mirror to the `event` table.
 *
 * `ToolUseQuery` (the schema, promoted from `experimental:tool_use` per
 * ADR-0011 §1.1) requires actor_kind='agent' — so user-fired debug-endpoint
 * calls never mirror, regardless of the tool's declared policy. The four
 * declared policies then fan out:
 *
 *   - 'never'             → never
 *   - 'always'            → always (provided caller is agent)
 *   - 'when_user_visible' → caller_ref matches copilot / teaching, with or without `agent:`
 *   - 'when_causal'       → tool effect is 'propose' | 'write',
 *                            OR caller_ref matches dreaming, with or without `agent:`
 *
 * Exported (with `__` prefix) so unit tests can pin the policy table without
 * spinning up the full bridge.
 */
function matchesAgentRef(ref: string, family: string): boolean {
  const bare = ref.replace(/^agent:/i, '').toLowerCase();
  return bare === family || bare.startsWith(`${family}:`);
}

export function __resolveMirrorPolicy(
  policy: ToolMirrorPolicy,
  callerActor: ToolCallerActor,
  effect: ToolEffect,
): boolean {
  if (callerActor.kind !== 'agent') return false;
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  if (policy === 'when_user_visible') {
    return (
      matchesAgentRef(callerActor.ref, 'copilot') || matchesAgentRef(callerActor.ref, 'teaching')
    );
  }
  // when_causal
  if (effect === 'propose' || effect === 'write') return true;
  return matchesAgentRef(callerActor.ref, 'dreaming');
}

export type { ToolExecutionGateInput, ToolExecutionResultObservation } from '@/kernel/tools/types';

/**
 * YUK-457 — live tool_use SSE gate. The streaming runner observes raw
 * tool_use block names (`mcp__<server>__<tool>`) BEFORE the bridge executes,
 * so the tool_use-side card gate resolves the DomainTool behind the name and
 * applies the SAME {@link __resolveMirrorPolicy} resolution that governs the
 * persisted tool_use mirror and {@link BuildMcpServerOptions.onToolComplete}.
 * One policy decision → live cards and replay tool_calls can't diverge.
 * Names outside `serverName` (native `Task`, remote MCP like Tavily) and
 * unregistered suffixes pass through: their user-visible surface is governed
 * elsewhere (subtask SSE / finalize force-done).
 */
export function shouldEmitToolUseForCaller(
  blockName: string,
  serverName: string,
  callerActor: ToolCallerActor,
): boolean {
  const prefix = `mcp__${serverName}__`;
  if (!blockName.startsWith(prefix)) return true;
  const dt = getTool(blockName.slice(prefix.length));
  if (!dt) return true;
  return __resolveMirrorPolicy(dt.mirrorEvent, callerActor, dt.effect);
}

function formatToolOperationFailure(record: ToolOperationRecord): string {
  const risk = record.sideEffectRisk ? `; side_effect_risk:${record.sideEffectRisk}` : '';
  return `${record.error?.code ?? record.status}: ${record.error?.message ?? 'operation did not succeed'}${risk}`;
}

function proposalEffectContract(
  name: string,
  effect: ToolEffect,
  output?: unknown,
): ProposalEffectContract | undefined {
  if (effect !== 'propose') return undefined;
  const base = {
    owner_gate: 'FULL',
    direct_write: false,
    rollback: 'dismiss_before_accept',
  } as const;
  if (output === null || typeof output !== 'object') return base;
  if (
    name === 'author_question' &&
    'status' in output &&
    output.status === 'proposed' &&
    'question_ids' in output &&
    Array.isArray(output.question_ids) &&
    output.question_ids.length > 0
  ) {
    return {
      ...base,
      retained_draft: {
        kind: 'question',
        written_before_accept: true,
        reversible: false,
        retained_after_dismiss: true,
      },
    };
  }
  const variantSucceeded =
    (name === 'propose_variant' && 'status' in output && output.status === 'generated') ||
    (name === 'author_question' && 'status' in output && output.status === 'proposed');
  if (
    variantSucceeded &&
    'mistake_variant_ids' in output &&
    Array.isArray(output.mistake_variant_ids) &&
    output.mistake_variant_ids.length > 0
  ) {
    return {
      ...base,
      retained_draft: {
        kind: 'mistake_variant',
        written_before_accept: true,
        reversible: false,
        retained_after_dismiss: true,
      },
    };
  }
  return base;
}

/**
 * Result of the optional per-call input interceptor (P5.1 / YUK-143). Lets the
 * Copilot context-budget tracker account a tool call and surface warning/hard
 * state. `args` is what the tool actually runs with; `truncationNote` (historic
 * field name), when present, is merged into output under `context_budget` so
 * the agent can self-correct and tool_call_log preserves the notice.
 */
export interface ToolInputInterceptResult {
  args: unknown;
  /**
   * Structured budget notice (any object). Merged verbatim into the tool
   * output as `context_budget`. Kept as `object` (not a named shape) so the
   * bridge stays decoupled from the throttle's `ContextBudgetNotice` type.
   */
  truncationNote?: object | null;
  /**
   * Graceful soft-stop signal (P5.1 / YUK-143 FIX 1). When the budget dimension
   * is exhausted the interceptor returns a reason string here INSTEAD of capped
   * args. The bridge treats it exactly like a `beforeExecute` reason: it does
   * NOT execute the tool and surfaces the string as the tool result, so the
   * agent stops and answers with what it has. This keeps the spec's central
   * "never a hard reject/throw" guarantee — the tool never runs with a `limit:0`
   * that would trip its own Zod min and throw.
   */
  softStop?: string | null;
}

export interface BuildMcpServerOptions {
  ctx: ToolContext;
  /** Logical mount name; tools surface as `mcp__<name>__<tool>`. */
  serverName: string;
  /** Subset of registered DomainTool names to expose. */
  toolNames: readonly string[];
  /** `task_kind` recorded on each tool_call_log row (defaults to ctx.callerActor.ref). */
  taskKind?: string;
  toolOperations?: ToolOperations;
  cancellationSignals?: ReadonlyArray<{
    signal: AbortSignal;
    requestedBy: 'system' | 'user';
  }>;
  /** Optional per-call runtime gate. Return a reason string to block execution. */
  beforeExecute?: (
    tool: ToolExecutionGateInput,
  ) => string | undefined | Promise<string | undefined>;
  /** Begins the in-flight effect barrier immediately before DomainTool.execute. */
  onExecuteStart?: (tool: ToolExecutionGateInput) => Promise<void> | void;
  /** Releases the barrier only after execution, logging and event mirroring settle. */
  onExecuteSettled?: (tool: ToolExecutionGateInput) => Promise<void> | void;
  /** Observes the exact agent-visible result after input interception and output decoration. */
  onResult?: (result: ToolExecutionResultObservation) => Promise<void> | void;
  /**
   * YUK-457 — fires after summarize completes with the human-facing summary string.
   * Used by Copilot inline SSE to render done-state tool-use cards. Fires ONLY
   * when the same {@link __resolveMirrorPolicy} resolution that persists the
   * tool_use mirror fires: a live card that no persisted mirror backs would
   * vanish on refresh (live/replay-same-rows invariant, materializing-tools.ts).
   * Failures are swallowed so visibility cannot abort paid work.
   */
  onToolComplete?: (result: {
    toolName: string;
    input: Record<string, unknown>;
    summary: string;
    errorReason?: string;
    /** YUK-920 — 同名并行 tool call 的确定性关联 id（有 correlated id 时携带）。 */
    toolUseId?: string;
  }) => void;
  /**
   * Optional per-call input interceptor (P5.1 / YUK-143). Runs AFTER
   * `beforeExecute` clears and BEFORE execute, only on the happy path. Receives
   * the zod-parsed args and returns the (possibly limit-capped) args plus an
   * optional truncation note. Used by the Copilot per-message context-budget
   * throttle. Dreaming and Coach use the same seam with their per-run budgets.
   */
  interceptInput?: (tool: ToolExecutionGateInput, args: unknown) => ToolInputInterceptResult;
}

/**
 * Options for {@link executeDomainToolCall} — the engine-neutral slice of
 * {@link BuildMcpServerOptions}. The pi AgentTool bridge (pi-tools.ts)
 * supplies the same fields; pi passes the loop's native toolCallId via
 * `correlatedToolUseId` (no hook round-trip needed).
 */
export interface DomainToolCallOptions {
  ctx: ToolContext;
  /** `task_kind` recorded on each tool_call_log row (defaults to ctx.callerActor.ref). */
  taskKind?: string;
  /** The agentLoop's native toolCall.id, forwarded for call correlation. */
  correlatedToolUseId?: string;
  toolOperations?: ToolOperations;
  cancellationSignals?: ReadonlyArray<{
    signal: AbortSignal;
    requestedBy: 'system' | 'user';
  }>;
  /** Optional per-call runtime gate. Return a reason string to block execution. */
  beforeExecute?: (
    tool: ToolExecutionGateInput,
  ) => string | undefined | Promise<string | undefined>;
  /** Begins the in-flight effect barrier immediately before DomainTool.execute. */
  onExecuteStart?: (tool: ToolExecutionGateInput) => Promise<void> | void;
  /** Releases the barrier only after execution, logging and event mirroring settle. */
  onExecuteSettled?: (tool: ToolExecutionGateInput) => Promise<void> | void;
  /** Observes the exact agent-visible result after input interception and output decoration. */
  onResult?: (result: ToolExecutionResultObservation) => Promise<void> | void;
  onToolComplete?: BuildMcpServerOptions['onToolComplete'];
  interceptInput?: BuildMcpServerOptions['interceptInput'];
}

/**
 * The engine-neutral DomainTool call pipeline — parse → beforeExecute gate →
 * interceptInput → execute (+ safe-handoff) → output schema → onResult →
 * summary → onToolComplete → tool_call_log → tool_use mirror → settle. The pi
 * AgentTool bridge wraps this verbatim via `AgentTool.execute` in
 * pi-tools.ts. Errors never throw — they encode into the returned text
 * payload exactly as the MCP convention requires.
 */
export async function executeDomainToolCall(
  dt: DomainTool<unknown, unknown>,
  rawArgs: unknown,
  opts: DomainToolCallOptions,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const call: ToolCallContext = {
    dt,
    opts,
    ctx: opts.ctx,
    taskKind: opts.taskKind ?? opts.ctx.callerActor.ref,
    startedAt: Date.now(),
    gateInput: { name: dt.name, effect: dt.effect },
    safeHandoffEnabled: Boolean(
      dt.safeHandoff && dt.effect === 'read' && opts.ctx.sessionId !== undefined,
    ),
    effectContract: proposalEffectContract(dt.name, dt.effect),
  };
  const parsed = parseInput(call, rawArgs);
  const gated = await runBeforeExecuteGate(call, parsed);
  const intercepted = applyInterceptInput(call, gated);
  const execution = decorateOutput(intercepted.input, await runExecute(call, intercepted));
  // Failed preparation/execution still goes through every bookkeeping phase.
  await notifyResult(call, intercepted.input, execution);
  const summary = summarizeResult(call, intercepted.input, execution);
  notifyToolComplete(call, intercepted.input, execution, summary);
  const toolCallLogId = await persistToolCallLog(call, intercepted.input, execution);
  await mirrorToolUse(call, intercepted.input, execution, summary, toolCallLogId);
  await settleExecution(call, execution);
  return formatToolResponse(intercepted.input, execution, summary);
}

type PhaseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
type ToolInputState = {
  readonly parsedInput: unknown;
  readonly execInput: unknown;
  readonly truncationNote: object | null;
  readonly correlatedToolUseId?: string;
};
type InputPhase = { readonly input: ToolInputState; readonly result: PhaseResult<undefined> };
type ExecutionPhase = {
  readonly result: PhaseResult<undefined>;
  readonly output: unknown;
  readonly executionStarted: boolean;
  readonly safeOperation?: ToolOperationRecord;
  readonly safeToolOperations?: ToolOperations;
  readonly effectContract?: ProposalEffectContract;
};
type ToolCallContext = {
  readonly dt: DomainTool<unknown, unknown>;
  readonly opts: DomainToolCallOptions;
  readonly ctx: ToolContext;
  readonly taskKind: string;
  readonly startedAt: number;
  readonly gateInput: ToolExecutionGateInput;
  readonly safeHandoffEnabled: boolean;
  readonly effectContract?: ProposalEffectContract;
};

function phaseError(error: unknown): { readonly ok: false; readonly error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Keep defined-but-empty error strings distinct from a successful phase. */
function errorReasonOf(result: PhaseResult<unknown>): string | undefined {
  return result.ok ? undefined : result.error;
}

function parseInput(call: ToolCallContext, rawArgs: unknown): InputPhase {
  try {
    const parsedInput = call.dt.inputSchema.parse(rawArgs);
    return {
      input: {
        parsedInput,
        execInput: parsedInput,
        truncationNote: null,
        correlatedToolUseId: call.opts.correlatedToolUseId,
      },
      result: { ok: true, value: undefined },
    };
  } catch (error) {
    // Parse failure logs the raw request and does not claim call correlation.
    return {
      input: { parsedInput: rawArgs, execInput: rawArgs, truncationNote: null },
      result: phaseError(error),
    };
  }
}

async function runBeforeExecuteGate(call: ToolCallContext, phase: InputPhase): Promise<InputPhase> {
  if (!phase.result.ok) return phase;
  try {
    const reason = await call.opts.beforeExecute?.(call.gateInput);
    return typeof reason === 'string' && reason.length > 0
      ? { ...phase, result: { ok: false, error: reason } }
      : phase;
  } catch (error) {
    return { ...phase, result: phaseError(error) };
  }
}

function applyInterceptInput(call: ToolCallContext, phase: InputPhase): InputPhase {
  if (!phase.result.ok || !call.opts.interceptInput) return phase;
  try {
    const intercepted = call.opts.interceptInput(
      { name: call.dt.name, effect: call.dt.effect },
      phase.input.execInput,
    );
    if (typeof intercepted.softStop === 'string' && intercepted.softStop.length > 0)
      return { ...phase, result: { ok: false, error: intercepted.softStop } };
    return {
      ...phase,
      input: {
        ...phase.input,
        execInput: intercepted.args,
        truncationNote: intercepted.truncationNote ?? null,
      },
    };
  } catch (error) {
    return { ...phase, result: phaseError(error) };
  }
}

function enforceOutputSchema(
  dt: DomainTool<unknown, unknown>,
  output: unknown,
): PhaseResult<unknown> {
  const parsed = dt.outputSchema.safeParse(output);
  if (parsed.success) return { ok: true, value: parsed.data };
  // Values stay redacted; field paths and their order are the error contract.
  const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
  return { ok: false, error: `output_schema_invalid: ${paths}` };
}

async function runExecute(call: ToolCallContext, phase: InputPhase): Promise<ExecutionPhase> {
  const { dt, opts, ctx, gateInput } = call;
  const { execInput, correlatedToolUseId } = phase.input;
  let executionStarted = false;
  let safeOperation: ToolOperationRecord | undefined;
  let safeToolOperations: ToolOperations | undefined;
  let output: unknown = null;
  let effectContract = call.effectContract;
  const result = (outcome: PhaseResult<undefined>): ExecutionPhase => ({
    result: outcome,
    output,
    executionStarted,
    safeOperation,
    safeToolOperations,
    effectContract,
  });
  if (!phase.result.ok) return result(phase.result);
  try {
    await opts.onExecuteStart?.(gateInput);
    executionStarted = true;
    safeToolOperations = call.safeHandoffEnabled
      ? (opts.toolOperations ?? getProcessToolOperations(ctx.db))
      : undefined;
    const safeExecution = safeToolOperations
      ? await executeSafeToolOperation({
          toolOperations: safeToolOperations,
          sessionId: ctx.sessionId as string,
          taskRunId: ctx.taskRunId,
          toolName: dt.name,
          toolUseId: correlatedToolUseId,
          input: execInput as Record<string, unknown>,
          ...(ctx.providerSessionDeadlineAt !== undefined
            ? { hardDeadlineAt: new Date(ctx.providerSessionDeadlineAt) }
            : {}),
          cancellationSignals: opts.cancellationSignals,
          execute: async (signal) => {
            const remoteOutput = await dt.execute({ ...ctx, signal }, execInput as never);
            const parsed = enforceOutputSchema(dt, remoteOutput);
            if (parsed.ok) return parsed.value;
            throw new Error(parsed.error);
          },
        })
      : undefined;
    safeOperation = safeExecution?.record;
    const rawOutput = safeOperation
      ? safeOperation.status === 'succeeded'
        ? safeOperation.result
        : null
      : await dt.execute(ctx, execInput as never);
    if (safeOperation && safeOperation.status !== 'succeeded')
      return result({ ok: false, error: formatToolOperationFailure(safeOperation) });
    // Preserve the outer parse even for a safe operation: transforms ran at both
    // boundaries before this extraction, and terminal evidence uses the inner one.
    const parsed = enforceOutputSchema(dt, rawOutput);
    if (!parsed.ok) return result(parsed);
    output = parsed.value;
    effectContract = proposalEffectContract(dt.name, dt.effect, output);
    return result({ ok: true, value: undefined });
  } catch (error) {
    return result(phaseError(error));
  }
}

function decorateOutput(input: ToolInputState, execution: ExecutionPhase): ExecutionPhase {
  if (!execution.result.ok || !input.truncationNote) return execution;
  const { output } = execution;
  return {
    ...execution,
    output:
      output !== null && typeof output === 'object' && !Array.isArray(output)
        ? { ...(output as Record<string, unknown>), context_budget: input.truncationNote }
        : { value: output, context_budget: input.truncationNote },
  };
}

async function notifyResult(
  call: ToolCallContext,
  input: ToolInputState,
  execution: ExecutionPhase,
): Promise<void> {
  const { dt, opts, ctx, gateInput } = call;
  const { execInput, correlatedToolUseId } = input;
  const { output, executionStarted, effectContract } = execution;
  const errorReason = errorReasonOf(execution.result);
  try {
    await opts.onResult?.({
      ...gateInput,
      ...(correlatedToolUseId ? { tool_use_id: correlatedToolUseId } : {}),
      // The context interceptor may cap a typed input before execution.
      // Review the exact input that produced this output, not the larger
      // request the model originally attempted.
      input: execInput,
      output: errorReason ? { error: errorReason } : output,
      error_reason: errorReason ?? null,
      executed: executionStarted,
      ...(effectContract ? { proposal_effect_contract: effectContract } : {}),
    });
  } catch (observationErr) {
    // A reply-review observer is bookkeeping only. It must never turn an
    // already-completed DomainTool effect into an agent-visible failure.
    console.error('[mcp-bridge] onResult failed', {
      tool: dt.name,
      task_run_id: ctx.taskRunId,
      err: observationErr,
    });
  }
}

function summarizeResult(
  call: ToolCallContext,
  input: ToolInputState,
  execution: ExecutionPhase,
): string {
  const { dt, ctx } = call;
  const { parsedInput } = input;
  const { output } = execution;
  const errorReason = errorReasonOf(execution.result);
  let summary = '';
  if (errorReason === undefined) {
    try {
      summary = dt.summarize(parsedInput as never, output as never);
    } catch (err) {
      const summaryError = err instanceof Error ? err.message : String(err);
      summary = `summary unavailable: ${summaryError}`;
      console.error('[mcp-bridge] tool summarize failed', {
        tool: dt.name,
        task_run_id: ctx.taskRunId,
        err,
      });
    }
  } else {
    summary = `error: ${errorReason}`;
  }

  return summary;
}

function notifyToolComplete(
  call: ToolCallContext,
  input: ToolInputState,
  execution: ExecutionPhase,
  summary: string,
): void {
  const { dt, opts, ctx } = call;
  const { execInput, correlatedToolUseId } = input;
  const errorReason = errorReasonOf(execution.result);
  // YUK-457 — same resolution as the persisted mirror below: a call that
  // will not mirror must not emit a live done-state card either.
  if (opts.onToolComplete && __resolveMirrorPolicy(dt.mirrorEvent, ctx.callerActor, dt.effect)) {
    try {
      opts.onToolComplete({
        toolName: dt.name,
        input: (execInput ?? {}) as Record<string, unknown>,
        summary,
        ...(errorReason ? { errorReason } : {}),
        ...(correlatedToolUseId ? { toolUseId: correlatedToolUseId } : {}),
      });
    } catch {
      // Visibility failures must never abort paid work.
    }
  }
}

async function persistToolCallLog(
  call: ToolCallContext,
  input: ToolInputState,
  execution: ExecutionPhase,
): Promise<string | undefined> {
  const { dt, ctx, taskKind, startedAt } = call;
  const { parsedInput } = input;
  const { output, safeOperation, safeToolOperations } = execution;
  const errorReason = errorReasonOf(execution.result);
  const latencyMs = Date.now() - startedAt;
  let toolCallLogId: string | undefined;
  try {
    toolCallLogId = await writeToolCallLog(ctx.db, {
      task_run_id: ctx.taskRunId,
      task_kind: taskKind,
      tool_name: dt.name,
      effect: dt.effect,
      input_json: parsedInput as Record<string, unknown>,
      output_json: errorReason ? { error: errorReason } : (output as object | null),
      error_reason: errorReason,
      iteration: 0,
      latency_ms: latencyMs,
      cost: 0,
    });
  } catch (logErr) {
    // Logging must not break the tool loop. The caller still gets a valid
    // result even if persistence fails.
    console.error('[mcp-bridge] writeToolCallLog failed', {
      tool: dt.name,
      task_run_id: ctx.taskRunId,
      err: logErr,
    });
  }

  if (toolCallLogId && safeOperation && safeOperation.status !== 'running') {
    try {
      await safeToolOperations?.linkTerminalToolCallLog(safeOperation.id, toolCallLogId);
    } catch (linkErr) {
      console.error('[mcp-bridge] terminal ToolOperations log link failed', {
        operation_id: safeOperation.id,
        tcl_id: toolCallLogId,
        err: linkErr,
      });
    }
  }

  return toolCallLogId;
}

async function mirrorToolUse(
  call: ToolCallContext,
  input: ToolInputState,
  execution: ExecutionPhase,
  summary: string,
  toolCallLogId: string | undefined,
): Promise<void> {
  const { dt, ctx } = call;
  const { parsedInput } = input;
  const errorReason = errorReasonOf(execution.result);
  // YUK-82 + ADR-0011 §1.1 (T-D7 / YUK-126): tool_use KnownEvent mirror
  // per mirrorEvent policy. Schema (`ToolUseQuery`) requires
  // actor_kind='agent', so user-fired calls never mirror regardless of
  // the tool's policy.
  if (__resolveMirrorPolicy(dt.mirrorEvent, ctx.callerActor, dt.effect)) {
    const mirrorPayload: Record<string, unknown> = {
      tool_name: dt.name,
      args: (parsedInput ?? {}) as Record<string, unknown>,
    };
    if (summary) mirrorPayload.result_summary = summary;
    if (errorReason) mirrorPayload.error_reason = errorReason;

    const mirrorId = `tool_use_${createId()}`;
    try {
      await writeEvent(ctx.db, {
        id: mirrorId,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: ctx.callerActor.ref,
        action: 'tool_use',
        subject_kind: 'query',
        subject_id: mirrorId,
        outcome: errorReason ? 'failure' : 'success',
        payload: mirrorPayload,
        caused_by_event_id: ctx.causedByEventId ?? null,
        task_run_id: ctx.taskRunId,
        cost_micro_usd: 0,
      });
      if (toolCallLogId) {
        try {
          await setToolCallLogMirroredEventId(ctx.db, toolCallLogId, mirrorId);
        } catch (linkErr) {
          console.error('[mcp-bridge] setToolCallLogMirroredEventId failed', {
            tool: dt.name,
            tcl_id: toolCallLogId,
            event_id: mirrorId,
            err: linkErr,
          });
        }
      }
    } catch (mirrorErr) {
      // Same principle — mirror failure must not crash the tool loop.
      console.error('[mcp-bridge] tool_use mirror writeEvent failed', {
        tool: dt.name,
        task_run_id: ctx.taskRunId,
        err: mirrorErr,
      });
    }
  }
}

async function settleExecution(call: ToolCallContext, execution: ExecutionPhase): Promise<void> {
  const { dt, opts, ctx, gateInput } = call;
  const { executionStarted } = execution;
  if (executionStarted) {
    try {
      await opts.onExecuteSettled?.(gateInput);
    } catch (settleErr) {
      // A bookkeeping observer must not turn a completed domain effect into
      // an agent-visible failure. Cancellation control still fails closed via
      // its persisted materializing-tool probe at terminal projection.
      console.error('[mcp-bridge] onExecuteSettled failed', {
        tool: dt.name,
        task_run_id: ctx.taskRunId,
        err: settleErr,
      });
    }
  }
}

function formatToolResponse(
  input: ToolInputState,
  execution: ExecutionPhase,
  summary: string,
): { content: Array<{ type: 'text'; text: string }> } {
  const { correlatedToolUseId } = input;
  const { output, effectContract } = execution;
  const errorReason = errorReasonOf(execution.result);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          errorReason
            ? {
                error: errorReason,
                summary,
                ...(correlatedToolUseId ? { tool_use_id: correlatedToolUseId } : {}),
                ...(effectContract ? { proposal_effect_contract: effectContract } : {}),
              }
            : {
                summary,
                output,
                ...(correlatedToolUseId ? { tool_use_id: correlatedToolUseId } : {}),
                ...(effectContract ? { proposal_effect_contract: effectContract } : {}),
              },
        ),
      },
    ],
  };
}
