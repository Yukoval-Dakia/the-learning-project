// Shared tool-call hook contracts. The runtime executes the ordered gate and
// observer chains; producers declare entries without importing that executor.

import type { AfterToolCallResult, BeforeToolCallResult } from '@earendil-works/pi-agent-core';

/** The tool invocation a hook observes. `agentType` marks nested calls
 *  (reply-finalization reads it to distinguish `root_call`). */
export interface PiHookToolCall {
  id: string;
  name: string;
  /** Declared subagent type for nested calls; undefined on the root loop. */
  agentType?: string;
  /** Independent execution-loop identity, including separate invocations of one agent type. */
  loopId?: string;
}

export type PiBeforeToolCall = (
  call: PiHookToolCall,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;

/** Settled attempt observation, including lookup, validation and hook rejection. */
export interface PiToolCallObservation {
  call: PiHookToolCall;
  args: Record<string, unknown>;
  isError: boolean;
  /** Declared domain effect; absent for tools without an effect contract. */
  effect?: 'read' | 'propose' | 'write' | 'control';
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
  /** Root loop owner policy. Nested loops always receive their own state. */
  progress?: {
    beforeToolCall: PiBeforeToolCall;
    afterToolCall: PiAfterToolCall;
    closure?(): { readonly reason: string } | undefined;
  };
  /** Ordered gate entries — the first defined result wins, including a non-blocking allow. */
  beforeToolCall?: PiBeforeToolCall[];
  /** Ordered observers — all run; failures are logged and swallowed. */
  afterToolCall?: PiAfterToolCall[];
}
