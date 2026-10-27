import type { AgentTool } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import type { Db } from '@/db/client';
import type { ToolOperations } from '@/kernel/tools/tool-operations';
import type {
  ToolContext,
  ToolExecutionGateInput,
  ToolExecutionResultObservation,
} from '@/kernel/tools/types';
import { zodToToolParametersSchema } from '@/kernel/zod-json-schema';

/**
 * Result of the per-call input interceptor (P5.1 / YUK-143): `args` is what the
 * tool actually runs with; a `truncationNote` is merged into output under
 * `context_budget` so the agent can self-correct.
 */
export interface ToolInputInterceptResult {
  args: unknown;
  /** Budget notice merged verbatim as `context_budget`; kept loosely typed so the
   *  bridge stays decoupled from the throttle's notice type. */
  truncationNote?: object | null;
  /**
   * Soft-stop: when a budget dimension is exhausted the interceptor returns a
   * reason here INSTEAD of capped args. The tool does not run and the reason is
   * surfaced as the result (never a hard reject/throw, never `limit:0`).
   */
  softStop?: string | null;
}

export interface BuildMcpServerOptions {
  ctx: ToolContext;
  /** YUK-1557 — active ai_task_runs.id for tool log/mirror attribution. */
  logTaskRunId?: string;
  /** Logical mount name; tools surface as `mcp__<name>__<tool>`. */
  serverName: string;
  /** Subset of registered DomainTool names to expose. */
  toolNames: readonly string[];
  /** `task_kind` recorded on each tool_call_log row (defaults to ctx.callerActor.ref). */
  taskKind?: string;
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
  /**
   * YUK-457 — fires with the human-facing summary after summarize, for Copilot
   * inline SSE done-state cards. Fires only when the mirror policy fires: a live
   * card without a persisted mirror would vanish on refresh. Failures swallowed.
   */
  onToolComplete?: (result: {
    toolName: string;
    input: Record<string, unknown>;
    summary: string;
    errorReason?: string;
    /** YUK-920 — correlation id for same-name parallel calls. */
    toolUseId?: string;
  }) => void;
  /**
   * P5.1 / YUK-143 — runs after `beforeExecute` clears and before execute on the
   * happy path; returns possibly limit-capped args plus an optional note.
   */
  interceptInput?: (tool: ToolExecutionGateInput, args: unknown) => ToolInputInterceptResult;
}

/** Namespaced wire name used by every mount kind. */
export function piToolWireName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** Loom-owned remote MCP config — the `{type:'http', url, headers}` subset the bridge consumes. */
export interface RemoteMcpHttpConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/** Declarative tool mount callers hand to the runner. */
export type PiToolMount =
  | {
      type: 'domain';
      /** Registry DomainTools compiled via {@link buildPiDomainAgentTools}. */
      options: BuildMcpServerOptions;
    }
  | {
      type: 'remote-mcp';
      serverName: string;
      config: RemoteMcpHttpConfig;
      /** Upstream tool names to expose (mirrors the caller's allowedTools scope). */
      toolNames: readonly string[];
      /**
       * YUK-1557 — required to persist one tool_call_log row (and unknown-cost
       * ledger row) per remote call; omitted mounts leave no audit row.
       */
      db?: Db;
    }
  | {
      type: 'custom';
      /**
       * Escape hatch for non-registry tools (agency evidence / director). The
       * caller owns execute and must keep logging semantics identical.
       */
      tools: AgentTool[];
    };

/** Convenience constructor for a domain mount descriptor. */
export function piDomainMount(options: BuildMcpServerOptions): PiToolMount {
  return { type: 'domain', options };
}

/**
 * Build one bespoke AgentTool for a `custom` mount. Wire name is
 * `mcp__<server>__<name>`; the handler returns the MCP-shaped payload.
 */
export function piCustomTool(
  serverName: string,
  name: string,
  description: string,
  schema: Record<string, z.ZodTypeAny> | z.ZodTypeAny,
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: 'text'; text: string }[] }>,
): AgentTool {
  return {
    name: piToolWireName(serverName, name),
    label: name,
    description,
    // YUK-1547 — the parameters root must declare type:"object": a union of object
    // branches otherwise compiles to a bare anyOf root the provider rejects (400).
    parameters: zodToToolParametersSchema(
      // A full Zod schema is the tool's parameters as-is (envelope-less submit);
      // a raw shape keeps the object wrapper.
      schema instanceof z.ZodType ? schema : z.object(schema),
      {
        io: 'input',
        reused: 'inline',
        target: 'draft-07',
      },
    ) as AgentTool['parameters'],
    execute: async (_toolCallId, params) => {
      const result = await handler((params ?? {}) as Record<string, unknown>);
      return { content: result.content, details: null };
    },
  };
}

/** Convenience constructor for a remote-MCP mount descriptor. */
export function piRemoteMcpMount(
  serverName: string,
  config: RemoteMcpHttpConfig,
  toolNames: readonly string[],
  db?: Db,
): PiToolMount {
  return { type: 'remote-mcp', serverName, config, toolNames, ...(db ? { db } : {}) };
}
