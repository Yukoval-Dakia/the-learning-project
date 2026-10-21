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

import { z } from 'zod';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { Db } from '@/db/client';

export type ToolEffect = 'read' | 'propose' | 'write' | 'control';

/**
 * YUK-1553 C1-1 — wire-safe placeholder for an opaque JSON document whose
 * shape an owner parser validates inside execute (e.g. a question draft).
 * Runtime admits JSON only; the static type stays `unknown` so internal
 * callers are not forced through the recursive JSON type. Effectful tools can
 * use this instead of `z.unknown()`/`z.record(z.string(), z.unknown())`, which
 * the registration contract rejects.
 */
export const OpaqueJsonInput: z.ZodType<unknown> = z.json();

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

/**
 * YUK-1404 (B2/R2) — media output contract. A DomainTool may declare an
 * optional `images` array in its OUTPUT: each entry is a versioned asset ref
 * (asset_id + `sha256:<64hex>` digest). The bridge resolves real bytes through
 * the digest-verifying asset loader and appends them as image content for the
 * model; tool_call_log and the tool_use mirror keep only the ref — bytes never
 * enter logs. `max_edge` down-scales the returned VIEW only (the stored asset
 * is never mutated). A crop is a separate capability (crop_image mints a new
 * derived asset), so there is deliberately no view-time region field.
 */
export interface ToolImageOutput {
  readonly ref: { readonly asset_id: string; readonly digest: string };
  readonly max_edge?: number;
}

/** The `images` field name a tool's outputSchema may carry. */
export const TOOL_OUTPUT_IMAGES_FIELD = 'images' as const;

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
  derivationPolicy?: DerivationPolicyT;
  db: Db;
  /** Server-bound current-turn original; never populated from model arguments. */
  reviewAnswer?: {
    readonly originalRef: string;
    readonly sessionId: string;
    submit(signal?: AbortSignal): Promise<
      | { kind: 'pending'; run_id: string }
      | {
          kind: 'committed';
          status: 'effective' | 'review_required';
          submission_id: string;
          attempt_id: string;
          candidate_id: string;
        }
    >;
  };
  sessionId?: string;
  validateLearningContent?: ValidateLearningContentFn;
  /** Caller-owned cancellation propagated into any nested AI work. */
  signal?: AbortSignal;
  /** Absolute caller wall clock propagated into nested central AI work. */
  providerSessionDeadlineAt?: number;
  providerAttemptCaller?: 'api' | 'worker';
  /**
   * YUK-1404 (B2/R2) — server-bound runtime scope (e.g.
   * `{kind:'ingestion_session', id:<sessionId>}`). Tools validate their inputs
   * against it when present; it is populated by the runner/caller only and can
   * never arrive via model arguments.
   */
  scope?: { readonly kind: string; readonly id?: string };
  taskRunId: string;
  /**
   * YUK-1557 — the caller's active ai_task_runs.id for observability rows
   * (tool_call_log / tool_use mirror / store events). Tools whose spend or
   * budget reservation uses a different internal id (ingestion agent segments)
   * keep that id in `taskRunId`; one run still owns all its tool evidence here.
   */
  logTaskRunId?: string;
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
