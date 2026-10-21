// YUK-921 P3 (YUK-1022) / P4 (YUK-1025) — the hook surface, the only tool-call
// interception surface since the SDK's `Options.hooks`/`canUseTool` retired.
//
//   deny           → beforeToolCall { block, reason }
//   interrupt      → beforeToolCall { block, reason, terminate }
//   post-execution → afterToolCall (isError covering failures)
//   compaction     → transformContext re-injection (adapter-owned)
//
// beforeToolCall entries run in declaration order with first defined result
// short-circuiting; afterToolCall observers all run after the tool settles.
// Observer failures are logged and fail open — visibility must never abort paid work.

import type { AfterToolCallResult, BeforeToolCallResult } from '@earendil-works/pi-agent-core';

/** The tool invocation a hook observes. `agentType` marks nested calls
 *  (reply-finalization reads it to distinguish `root_call`). */
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
  /** True when the abort lineage was live as the tool settled. */
  interrupted?: boolean;
}

/**
 * Post-execution observer. May return an override — e.g. reply-finalization
 * appends `tool_use_id=` context the model sees.
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

/** Fan an observation out to every observer. Returns the merged override —
 *  later defined fields win (pi applies the result field-wise). */
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
