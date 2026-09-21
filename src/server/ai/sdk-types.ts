// YUK-921 P4 (YUK-1025) — the runner's normalized wire vocabulary.
//
// These types describe the frame/call-spec contract the Claude Agent SDK
// used to emit; the package itself is retired, and PiAgentAdapter is now the
// only producer. The `SDK*` names stay so the consume loop (lifecycle /
// terminal evidence / tool_call recording / durable task_* projection) keeps
// a single vocabulary — these are OUR protocol types now, sized to the fields
// this codebase reads. SDK-only knobs (env/cwd/permissionMode/persistSession/
// hooks/agents/skills/settingSources/title/maxBudgetUsd) are gone.
//
// Anthropic Messages payload types (BetaMessage/MessageParam) come
// from `@anthropic-ai/sdk`, which remains a dependency (pi-ai's anthropic
// driver is built on it and runner.ts already imports ContentBlock from it).

import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { EffortLevel } from '@/ai/task-spec';

type UUID = string;

// ---------------------------------------------------------------------------
// Per-call adapter options (the pruned SDK `Options`).
// ---------------------------------------------------------------------------

/**
 * The per-attempt call spec `buildQueryOptions` produces and the adapter
 * consumes. Post-P4 this carries only what the pi lane can honour: model /
 * systemPrompt / abort / turn ceiling / tool allowlist / reasoning effort /
 * session resume pointer.
 */
export interface Options {
  /** Catalog model id inside the resolved provider. */
  model?: string;
  /** Plain-string system prompt (SDK preset objects were never produced here). */
  systemPrompt?: string;
  /** Caller+lifecycle abort — propagates into the agentLoop signal chain. */
  abortController?: AbortController;
  /** Agentic-turn ceiling — pi enforces it via `shouldStopAfterTurn`. */
  maxTurns?: number;
  /** allowedTools allowlist — `mcp__<server>__<tool>` wire names. */
  tools?: string[];
  /** Reasoning effort tier → pi `reasoning` stream option. */
  effort?: EffortLevel;
  /**
   * `pi:`-prefixed session id to resume. The pi lane has no provider session
   * file — resume requires `ctx.piSessionReplay` (durable-turn fold), enforced
   * fail-closed at adapter startup.
   */
  resume?: string;
}

// ---------------------------------------------------------------------------
// Shared value objects
// ---------------------------------------------------------------------------

export type TerminalReason = string;

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
  canonicalModel?: string;
  provider?: string;
}

/** Terminal-frame usage the adapter emits: the four token counters every
 *  consumer reads (sdk-terminal's accumulateUsage reads exactly these). Pi
 *  carries no service_tier/server_tool_use breakdown — don't claim one. */
export type ResultUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export interface SDKPermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Message frames
// ---------------------------------------------------------------------------

export interface SDKAssistantMessage {
  type: 'assistant';
  message: BetaMessage;
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
  subagent_type?: string;
}

export interface SDKUserMessage {
  type: 'user';
  message: MessageParam;
  parent_tool_use_id: string | null;
  uuid?: UUID;
  session_id?: string;
  subagent_type?: string;
}

export interface SDKResultSuccess {
  type: 'result';
  subtype: 'success';
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  api_error_status?: number | null;
  num_turns: number;
  result: string;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: ResultUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  structured_output?: unknown;
  terminal_reason?: TerminalReason;
  uuid: UUID;
  session_id: string;
}

export interface SDKResultError {
  type: 'result';
  subtype:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries';
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: ResultUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  errors: string[];
  terminal_reason?: TerminalReason;
  uuid: UUID;
  session_id: string;
}

export type SDKResultMessage = SDKResultSuccess | SDKResultError;

export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth' | 'none';

// ---------------------------------------------------------------------------
// Permission callback (the pruned `canUseTool` contract)
// ---------------------------------------------------------------------------

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

export interface SDKSystemMessage {
  type: 'system';
  subtype: 'init';
  agents?: string[];
  apiKeySource?: ApiKeySource;
  claude_code_version?: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: { name: string; status: string }[];
  model?: string;
  permissionMode?: PermissionMode;
  slash_commands?: string[];
  uuid: UUID;
  session_id: string;
}

export interface SDKCompactBoundaryMessage {
  type: 'system';
  subtype: 'compact_boundary';
  compact_metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
    post_tokens?: number;
    duration_ms?: number;
  };
  uuid: UUID;
  session_id: string;
}

export interface SDKTaskStartedMessage {
  type: 'system';
  subtype: 'task_started';
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;
  task_type?: string;
  /** Workflow task name — present on local_workflow task_started frames. */
  workflow_name?: string;
  prompt?: string;
  /** Ambient/housekeeping task — hide from the inline transcript. */
  skip_transcript?: boolean;
  uuid: UUID;
  session_id: string;
}

export interface SDKTaskProgressMessage {
  type: 'system';
  subtype: 'task_progress';
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;
  usage: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  last_tool_name?: string;
  summary?: string;
  uuid: UUID;
  session_id: string;
}

export interface SDKTaskUpdatedMessage {
  type: 'system';
  subtype: 'task_updated';
  task_id: string;
  /** Wire-safe subset of TaskState fields that changed. */
  patch: {
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  uuid: UUID;
  session_id: string;
}

export interface SDKTaskNotificationMessage {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file?: string;
  summary: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  skip_transcript?: boolean;
  uuid: UUID;
  session_id: string;
}

/**
 * The normalized frame union the runner consumes. Sized to what the codebase
 * produces/discriminates: assistant, user, result, system init,
 * compact_boundary, and the durable task_* lifecycle frames.
 */
export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKCompactBoundaryMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKTaskNotificationMessage;

// ---------------------------------------------------------------------------
// Nested-agent declarations (callers keep authoring these).
// ---------------------------------------------------------------------------

/** Depth-reduced nested-agent spec — the caller-declared subagent definition. */
export interface AgentDefinition {
  description: string;
  prompt: string;
  /** Wire-name allowlist (`mcp__<server>__<tool>` or local tool names). */
  tools?: string[];
  disallowedTools?: string[];
  /** Pi catalog model id or 'inherit'; SDK alias names fail closed. */
  model?: string;
  /** Per-child assistant-turn ceiling. */
  maxTurns?: number;
  /** Kept for declared-surface parity — pi runs children synchronously. */
  background?: boolean;
}
