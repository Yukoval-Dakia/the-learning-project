// YUK-79 / Foundation D M1 / spec `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md`
//
// DomainTool contract — the canonical type that every read / propose / write
// tool exposed to LLM tool-call loops must implement. Tools are registered
// once via `registerTool` and then assembled into per-request MCP servers
// (Lane C) so the Claude Agent SDK can call them as `mcp__<server>__<name>`.
//
// Out of scope for Lane A: actual tool implementations (Lane B), the MCP
// bridge wrapper (Lane C), `tool_use` event mirror writer (Lane D, promoted
// out of `experimental:tool_use` per ADR-0011 §1.1). This file is
// interface-only.

import type { z } from 'zod';
import type { Db } from '@/db/client';

export type ToolEffect = 'read' | 'propose' | 'write';

export interface ProposalEffectContract {
  readonly owner_gate: 'FULL';
  readonly direct_write: false;
  readonly rollback: 'dismiss_before_accept';
  readonly retained_draft?: {
    readonly kind: 'question' | 'mistake_variant';
    readonly written_before_accept: true;
    readonly reversible: false;
    readonly retained_after_dismiss: true;
  };
}

export interface ToolExecutionGateInput {
  readonly name: string;
  readonly effect: ToolEffect;
}

export interface ToolExecutionResultObservation extends ToolExecutionGateInput {
  readonly tool_use_id?: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly error_reason: string | null;
  readonly executed: boolean;
  readonly proposal_effect_contract?: ProposalEffectContract;
}

/**
 * mirrorEvent policy — when the bridge (Lane C+D) should write an
 * `event(action='tool_use')` row for this tool's invocation (promoted
 * from `experimental:tool_use` per ADR-0011 §1.1, T-D7 / YUK-126).
 * The bridge resolves which path fires based on (effect, callerActor):
 *   - 'never'              → never mirror; tool_call_log only
 *   - 'when_user_visible'  → mirror when caller is copilot / teaching, with or without `agent:`
 *   - 'when_causal'        → mirror when effect ∈ {propose, write} OR caller is dreaming
 *   - 'always'             → mirror unconditionally
 */
export type ToolMirrorPolicy = 'never' | 'when_user_visible' | 'when_causal' | 'always';

export type ToolCostClass = 'local' | 'cheap_llm' | 'expensive_llm';

export interface ToolCallerActor {
  kind: 'user' | 'agent' | 'cron' | 'system';
  /** `'agent:copilot'`, `'dreaming'`, `'cron:knowledge_maintenance'`, ... */
  ref: string;
}

export interface LearningContentValidationRequest {
  subjectId: string;
  questions: Array<{
    id: string;
    kind: string;
    prompt_md: string;
    reference_md: string | null;
    choices_md: string[] | null;
    rubric_json?: unknown;
    knowledge_ids?: string[] | null;
  }>;
}

export interface LearningContentValidationOutcome {
  verdict: 'pass' | 'fail' | 'needs_repair';
  items: unknown[];
}

export type ValidateLearningContentFn = (
  content: LearningContentValidationRequest,
) => Promise<LearningContentValidationOutcome>;

export interface ToolContext {
  db: Db;
  sessionId?: string;
  validateLearningContent?: ValidateLearningContentFn;
  /** Caller-owned cancellation propagated into any nested AI work. */
  signal?: AbortSignal;
  /** Absolute caller wall clock propagated into nested central AI work. */
  providerSessionDeadlineAt?: number;
  providerAttemptCaller?: 'api' | 'worker';
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
  safeHandoff?: {
    readonly transport: 'remote';
    readonly idempotent: true;
  };
  /** Run the tool. Soft-fail (empty result) returns a valid Output; hard-fail throws. */
  execute(ctx: ToolContext, input: Input): Promise<Output>;
  /** Folded UI summary; e.g. `"mistakes · 8 rows · 3 due"`. Must not exceed ~120 chars. */
  summarize(input: Input, output: Output): string;
  mirrorEvent: ToolMirrorPolicy;
}
