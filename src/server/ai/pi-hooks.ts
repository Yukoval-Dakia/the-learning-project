// YUK-921 P3 (YUK-1022) / P4 (YUK-1025) — the hook surface.
//
// Post-P4 this is the ONLY tool-call interception surface (the retired SDK's
// `Options.hooks`/`canUseTool` are gone). Producers (spawn-contract /
// cancellation / reply-finalization) emit their entries from one shared
// decision core:
//
//   deny              → beforeToolCall { block, reason }
//   interrupt         → beforeToolCall { block, reason, terminate }
//   post-execution    → afterToolCall (isError=false / true for failures)
//   compaction        → transformContext re-injection (adapter-owned)
//
// Ordering: all beforeToolCall entries run in declaration order (first defined
// result short-circuits); afterToolCall observers run in declaration order
// after the tool settles. Observer failures are logged and fail open —
// visibility must never abort paid work.

import type { AfterToolCallResult, BeforeToolCallResult } from '@earendil-works/pi-agent-core';

/** The tool invocation a hook observes. `agentType` is set when the call runs
 *  inside a nested subagent loop — the pi equivalent of the SDK hook input's
 *  `agent_id` field (reply-finalization uses it to mark `root_call`). */
export interface PiHookToolCall {
  id: string;
  name: string;
  /** Declared subagent type for nested calls; undefined on the root loop. */
  agentType?: string;
}

export type PiBeforeToolCall = (
  call: PiHookToolCall,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;

/** Post-execution observation — fires for success and failure (isError). */
export interface PiToolCallObservation {
  call: PiHookToolCall;
  args: Record<string, unknown>;
  isError: boolean;
  /** The tool's result payload when it settled (absent on execute-throw). */
  output?: unknown;
  /** The thrown/settled error value when isError. */
  error?: unknown;
  /** True when the abort lineage was live as the tool settled — the pi
   *  equivalent of SDK PostToolUseFailure's `is_interrupt`. */
  interrupted?: boolean;
}

/**
 * Post-execution observer. May return an AfterToolCallResult override — the
 * pi equivalent of SDK PostToolUse's `additionalContext` write-back (e.g.
 * reply-finalization appends `tool_use_id=` context the model sees). Most
 * observers return undefined.
 */
export type PiAfterToolCall = (
  observation: PiToolCallObservation,
  signal?: AbortSignal,
) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;

export interface PiHookBridge {
  /** Ordered gate entries — the first defined result wins (deny short-circuits). */
  beforeToolCall?: PiBeforeToolCall[];
  /** Ordered observers — all run; failures are logged and swallowed. */
  afterToolCall?: PiAfterToolCall[];
}

/** Run the ordered beforeToolCall chain; first blocking/defined result wins. */
export async function runPiBeforeToolCall(
  bridge: PiHookBridge | undefined,
  call: PiHookToolCall,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BeforeToolCallResult | undefined> {
  for (const entry of bridge?.beforeToolCall ?? []) {
    const result = await entry(call, args, signal);
    if (result !== undefined) return result;
  }
  return undefined;
}

/** Fan an observation out to every afterToolCall entry; failures log+continue.
 *  Returns the merged override — later entries' defined fields win over
 *  earlier ones (pi applies the result field-wise). */
export async function emitPiAfterToolCall(
  bridge: PiHookBridge | undefined,
  observation: PiToolCallObservation,
  signal?: AbortSignal,
): Promise<AfterToolCallResult | undefined> {
  let merged: AfterToolCallResult | undefined;
  for (const entry of bridge?.afterToolCall ?? []) {
    try {
      const result = await entry(observation, signal);
      if (result !== undefined) merged = { ...merged, ...result };
    } catch (error) {
      console.warn('[pi-hooks] afterToolCall observer failed (continuing)', {
        tool: observation.call.name,
        tool_use_id: observation.call.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return merged;
}
