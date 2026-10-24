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

import type {
  PiHookBridge,
  PiHookToolCall,
  PiToolCallObservation,
} from '@/core/tool-call-contract';

/** Run the ordered beforeToolCall chain; first defined result wins, including allow. */
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
