// YUK-81 + YUK-82 — engine-neutral bridge from registry DomainTools to the
// `mcp__<server>__<tool>` wire names agents see. YUK-1025 — pi is the only engine;
// pi-tools.ts compiles mounts into AgentTools over this shared pipeline.
//
// Every call lands one tool_call_log row plus, per mirror policy, a `tool_use`
// KnownEvent mirror so Copilot / Dreaming / Coach can replay tool history.

import { createHash } from 'node:crypto';

import { createId } from '@paralleldrive/cuid2';
import type { BuildMcpServerOptions } from '@/ai/pi-tool-mount';
import { type DerivationPolicyT, readDerivationPolicy } from '@/core/schema/derivation-policy';
import { writeEvent } from '@/kernel/events';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import { createAssessmentAssetLoader } from '@/kernel/records/assessment-assets';
import { setToolCallLogMirroredEventId, writeToolCallLog } from '@/kernel/tools/call-evidence';
import { derivationToolDenial } from '@/kernel/tools/derivation-policy';
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
import { TOOL_OUTPUT_IMAGES_FIELD } from '@/kernel/tools/types';
import { getTool } from './registry';

/**
 * Engine-neutral tool-result content: MCP-shaped JSON text, or real image bytes
 * resolved from a versioned asset ref.
 */
export type DomainToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** Cap on resolved image blocks per call — a runaway output can't flood the context. */
const MAX_TOOL_OUTPUT_IMAGES = 8;
/** Absolute long-edge cap for the returned view; tools may request smaller. */
const MAX_TOOL_IMAGE_EDGE = 2048;

function matchesAgentRef(ref: string, family: string): boolean {
  const bare = ref.replace(/^agent:/i, '').toLowerCase();
  return bare === family || bare.startsWith(`${family}:`);
}

/**
 * Whether one call mirrors to the `event` table. `ToolUseQuery` requires
 * actor_kind='agent', so user-fired calls never mirror. Declared policies:
 *
 *   - 'never'             → never
 *   - 'always'            → always (agent callers only)
 *   - 'when_user_visible' → copilot / teaching caller_ref
 *   - 'when_causal'       → propose | write effect, or dreaming caller_ref
 *
 * Exported with `__` so tests can pin the policy table.
 */
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
 * YUK-457 — live tool_use SSE gate. Applies the same mirror policy that governs
 * the persisted mirror, so live cards and replay cannot diverge. Names outside
 * this server and unregistered suffixes pass through: their visibility is
 * governed elsewhere (subtask SSE / finalize force-done).
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
 * Options for {@link executeDomainToolCall} — the engine-neutral slice of
 * {@link BuildMcpServerOptions}. The pi AgentTool bridge passes the loop's native
 * toolCallId as `correlatedToolUseId`.
 */
export interface DomainToolCallOptions {
  ctx: ToolContext;
  /** YUK-1557 — ai_task_runs.id for tool_call_log / mirror attribution. Defaults
   *  to ctx.taskRunId; the runner injects its active run id. */
  logTaskRunId?: string;
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

/** Engine-neutral DomainTool result; `isError` is the authoritative failure flag. */
export interface DomainToolCallResult {
  content: DomainToolResultContent[];
  /** True when any pipeline phase failed; derived from the phase `ok` flag, never
   *  inferred from the serialized content. */
  isError: boolean;
}

/**
 * The DomainTool call pipeline: parse → beforeExecute → interceptInput → execute
 * (+ safe handoff) → output schema → onResult → summary → tool_call_log →
 * tool_use mirror → settle. Errors never throw: they encode into the text payload
 * with `isError` marking the failure so the engine need not parse it.
 */
export async function executeDomainToolCall(
  dt: DomainTool<unknown, unknown>,
  rawArgs: unknown,
  opts: DomainToolCallOptions,
): Promise<DomainToolCallResult> {
  const declared = readDerivationPolicy({ derivation_policy: opts.ctx.derivationPolicy });
  const sourcePolicy = opts.ctx.causedByEventId
    ? await readEventDerivationPolicy(opts.ctx.db, opts.ctx.causedByEventId)
    : declared;
  // YUK-1398 — keep restricted purposes (answer_only / crisis) from collapsing
  // back to allow; the causal root wins over the declared value.
  const policy: DerivationPolicyT =
    sourcePolicy !== 'allow' ? sourcePolicy : declared !== 'allow' ? declared : 'allow';
  const call: ToolCallContext = {
    dt,
    opts,
    ctx: {
      ...opts.ctx,
      ...(opts.logTaskRunId ? { logTaskRunId: opts.logTaskRunId } : {}),
      derivationPolicy: policy,
    },
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
  const images = await resolveOutputImages(call, execution);
  // Failed preparation/execution still goes through every bookkeeping phase.
  await notifyResult(call, intercepted.input, execution);
  const summary = summarizeResult(call, intercepted.input, execution);
  notifyToolComplete(call, intercepted.input, execution, summary);
  const toolCallLogId = await persistToolCallLog(call, intercepted.input, execution);
  await mirrorToolUse(call, intercepted.input, execution, summary, toolCallLogId);
  await settleExecution(call, execution);
  return formatToolResponse(intercepted.input, execution, summary, images);
}

/**
 * YUK-1404 (B2/R2) — media output: an `images` array of versioned refs
 * ({asset_id, digest}, optional max_edge) is loaded through the digest-verifying
 * asset loader and appended as image content. Bytes never enter tool_call_log or
 * the mirror — those persist refs only. Resolution failures degrade to an
 * explicit text note, never silently.
 */
async function resolveOutputImages(
  call: ToolCallContext,
  execution: ExecutionPhase,
): Promise<DomainToolResultContent[]> {
  if (!execution.result.ok) return [];
  const output = execution.output;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return [];
  const declared = (output as Record<string, unknown>)[TOOL_OUTPUT_IMAGES_FIELD];
  if (!Array.isArray(declared) || declared.length === 0) return [];

  const loader = createAssessmentAssetLoader(call.ctx.db, async (key) => {
    // Lazy: R2 env is only required when a media-producing tool actually runs.
    const { getR2 } = await import('@/server/r2');
    return getR2().get(key);
  });
  const signal = call.ctx.signal ?? new AbortController().signal;

  const blocks: DomainToolResultContent[] = [];
  const entries = declared.slice(0, MAX_TOOL_OUTPUT_IMAGES);
  for (const entry of entries) {
    const note = (detail: string): DomainToolResultContent => ({
      type: 'text' as const,
      text: JSON.stringify({ image_unavailable: detail }),
    });
    const ref =
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as { ref?: unknown }).ref === 'object' &&
      (entry as { ref: unknown }).ref !== null
        ? (entry as { ref: { asset_id?: unknown; digest?: unknown }; max_edge?: unknown })
        : null;
    if (
      ref === null ||
      typeof ref.ref.asset_id !== 'string' ||
      typeof ref.ref.digest !== 'string'
    ) {
      blocks.push(note('malformed image ref in tool output'));
      continue;
    }
    const assetRef = { asset_id: ref.ref.asset_id, digest: ref.ref.digest };
    let loaded: { bytes: Uint8Array; mime_type: string } | null;
    try {
      loaded = await loader(assetRef, signal);
    } catch {
      loaded = null;
    }
    if (!loaded) {
      blocks.push(note(`asset '${assetRef.asset_id}' digest did not verify or bytes are missing`));
      continue;
    }
    // The loader checks row-digest + byte length, not the served content —
    // hash the fetched bytes before they reach the model (fail closed on drift).
    const servedSha = createHash('sha256').update(loaded.bytes).digest('hex');
    if (servedSha !== assetRef.digest.toLowerCase().replace(/^sha256:/, '')) {
      blocks.push(
        note(`asset '${assetRef.asset_id}' served bytes do not match the requested digest`),
      );
      continue;
    }
    if (!loaded.mime_type.startsWith('image/')) {
      blocks.push(note(`asset '${assetRef.asset_id}' is ${loaded.mime_type}, not an image`));
      continue;
    }
    let bytes = loaded.bytes;
    let mimeType = loaded.mime_type;
    const maxEdge =
      typeof ref.max_edge === 'number' ? Math.min(ref.max_edge, MAX_TOOL_IMAGE_EDGE) : 0;
    if (maxEdge > 0) {
      try {
        const { default: sharp } = await import('sharp');
        const meta = await sharp(Buffer.from(bytes)).metadata();
        if (meta.width && meta.height && Math.max(meta.width, meta.height) > maxEdge) {
          const format =
            meta.format === 'jpeg' || meta.format === 'png' || meta.format === 'webp'
              ? meta.format
              : 'png';
          const resized = await sharp(Buffer.from(bytes))
            .resize({
              width: meta.width >= meta.height ? maxEdge : undefined,
              height: meta.height > meta.width ? maxEdge : undefined,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .toFormat(format)
            .toBuffer();
          bytes = new Uint8Array(resized.buffer, resized.byteOffset, resized.byteLength);
          mimeType = `image/${format}`;
        }
      } catch {
        // A view-time downscale failure falls back to the original bytes — the
        // content is still honest (same verified asset), just larger.
      }
    }
    blocks.push({
      type: 'image',
      data: Buffer.from(bytes).toString('base64'),
      mimeType,
    });
  }
  if (declared.length > MAX_TOOL_OUTPUT_IMAGES) {
    blocks.push({
      type: 'text',
      text: JSON.stringify({
        image_unavailable: `${declared.length - MAX_TOOL_OUTPUT_IMAGES} image(s) omitted over the ${MAX_TOOL_OUTPUT_IMAGES}-image per-call cap`,
      }),
    });
  }
  return blocks;
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
    const reason =
      derivationToolDenial(call.ctx.derivationPolicy ?? 'allow', call.gateInput) ??
      (await call.opts.beforeExecute?.(call.gateInput));
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
    // boundaries and terminal evidence uses the inner one.
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
      // Review the exact input that produced this output, not the larger request
      // the model originally attempted.
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
      task_run_id: ctx.logTaskRunId ?? ctx.taskRunId,
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
  // YUK-82 + ADR-0011 §1.1 — tool_use KnownEvent mirror per mirrorEvent policy.
  if (__resolveMirrorPolicy(dt.mirrorEvent, ctx.callerActor, dt.effect)) {
    const mirrorPayload: Record<string, unknown> = {
      tool_name: dt.name,
      derivation_policy: ctx.derivationPolicy ?? 'allow',
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
        task_run_id: ctx.logTaskRunId ?? ctx.taskRunId,
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
      // Bookkeeping must not turn a completed domain effect into an agent-visible
      // failure. Cancellation still fails closed via the terminal probe.
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
  images: DomainToolResultContent[],
): DomainToolCallResult {
  const { correlatedToolUseId } = input;
  const { output, effectContract } = execution;
  const errorReason = errorReasonOf(execution.result);
  return {
    // YUK-1559 — authoritative phase outcome, so engine mounts can flag the
    // wire-level error instead of inferring it from text.
    isError: errorReason !== undefined,
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
      ...images,
    ],
  };
}
