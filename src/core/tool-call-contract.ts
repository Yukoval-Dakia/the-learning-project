// Shared tool-call hook contracts. The runtime executes the ordered gate and
// observer chains; producers declare entries without importing that executor.

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
  /** Ordered gate entries — the first defined result wins, including a non-blocking allow. */
  beforeToolCall?: PiBeforeToolCall[];
  /** Ordered observers — all run; failures are logged and swallowed. */
  afterToolCall?: PiAfterToolCall[];
}
