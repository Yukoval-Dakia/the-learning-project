// YUK-79 / Foundation D M1 / spec `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md`
//
// DomainTool contract — the canonical type that every read / propose / write
// tool exposed to LLM tool-call loops must implement. Tools are registered
// once via `registerTool` and then assembled into per-request MCP servers
// (Lane C) so the Claude Agent SDK can call them as `mcp__<server>__<name>`.
//
// Out of scope for Lane A: actual tool implementations (Lane B), the MCP
// bridge wrapper (Lane C), `experimental:tool_use` event mirror writer
// (Lane D). This file is interface-only.

import type { Db } from '@/db/client';
import type { z } from 'zod';

export type ToolEffect = 'read' | 'propose' | 'write';

/**
 * mirrorEvent policy — when the bridge (Lane C+D) should write an
 * `event(action='experimental:tool_use')` row for this tool's invocation.
 * The bridge resolves which path fires based on (effect, callerActor):
 *   - 'never'              → never mirror; tool_call_log only
 *   - 'when_user_visible'  → mirror when caller is `agent:copilot:*` or `agent:teaching:*`
 *   - 'when_causal'        → mirror when effect ∈ {propose, write} OR caller is `agent:dreaming:*`
 *   - 'always'             → mirror unconditionally
 */
export type ToolMirrorPolicy = 'never' | 'when_user_visible' | 'when_causal' | 'always';

export type ToolCostClass = 'local' | 'cheap_llm' | 'expensive_llm';

export interface ToolCallerActor {
  kind: 'user' | 'agent' | 'cron' | 'system';
  /** `'agent:copilot'`, `'agent:dreaming:variant_propose'`, `'cron:knowledge_maintenance'`, ... */
  ref: string;
}

export interface ToolContext {
  db: Db;
  taskRunId: string;
  callerActor: ToolCallerActor;
  /** When set, mirror events use this as `caused_by_event_id`. */
  causedByEventId?: string;
}

/**
 * Contract every DomainTool implements. Generic over Input/Output so the
 * registry can carry strongly-typed tools while still being storable in a
 * single map. Use `DomainTool<unknown, unknown>` at the storage site.
 */
export interface DomainTool<Input = unknown, Output = unknown> {
  /** Stable identifier; matches MCP tool name after `mcp__<server>__` prefix. */
  name: string;
  /** Sent to the LLM. Keep concise and concrete. */
  description: string;
  effect: ToolEffect;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  costClass: ToolCostClass;
  /** Run the tool. Soft-fail (empty result) returns a valid Output; hard-fail throws. */
  execute(ctx: ToolContext, input: Input): Promise<Output>;
  /** Folded UI summary; e.g. `"mistakes · 8 rows · 3 due"`. Must not exceed ~120 chars. */
  summarize(input: Input, output: Output): string;
  mirrorEvent: ToolMirrorPolicy;
}
