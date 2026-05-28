// YUK-81 + YUK-82 / Foundation D M1 Lane C + Lane D
//
// Generic bridge: wrap any DomainTool from the registry into a Claude Agent
// SDK MCP server tool. Replaces the per-task hand-written
// `buildKnowledgeReviewMcpServer` pattern for any future task that needs
// access to read / propose / write tools.
//
// Each tool call:
//   1. zod-parse the raw args (the SDK already parses ZodRawShape on its
//      side but we re-parse to get the typed Input value and a stable
//      error path).
//   2. execute the tool against the captured ToolContext.
//   3. write a tool_call_log row with effect + error_reason populated.
//   4. resolve mirrorEvent policy and, when it fires, write an
//      `experimental:tool_use` event mirror with payload
//      { tool_name, args, result_summary, error_reason? } so Copilot /
//      Dreaming / Coach can replay tool history from the event log.
//      Lane D added this — schema is locked in src/core/schema/event/
//      experimental.ts `ToolUseExperimental` (ADR-0011 §1).
//   5. return an MCP-shaped { content: [{ type: 'text', text: <json> }] }
//      result the LLM can read.

import { setToolCallLogMirroredEventId, writeToolCallLog } from '@/server/ai/log';
import { writeEvent } from '@/server/events/queries';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';
import { registerCoreTools } from './bootstrap';
import { getTool } from './registry';
import type { ToolCallerActor, ToolContext, ToolEffect, ToolMirrorPolicy } from './types';

/**
 * Decide whether a tool invocation should mirror to the `event` table.
 *
 * `ToolUseExperimental` (the schema) requires actor_kind='agent' — so
 * user-fired debug-endpoint calls never mirror, regardless of the tool's
 * declared policy. The four declared policies then fan out:
 *
 *   - 'never'             → never
 *   - 'always'            → always (provided caller is agent)
 *   - 'when_user_visible' → caller_ref matches copilot / teaching, with or without `agent:`
 *   - 'when_causal'       → tool effect is 'propose' | 'write',
 *                            OR caller_ref matches dreaming, with or without `agent:`
 *
 * Exported (with `__` prefix) so unit tests can pin the policy table without
 * spinning up the full bridge.
 */
function matchesAgentRef(ref: string, family: string): boolean {
  const bare = ref.replace(/^agent:/i, '').toLowerCase();
  return bare === family || bare.startsWith(`${family}:`);
}

export function __resolveMirrorPolicy(
  policy: ToolMirrorPolicy,
  callerActor: ToolCallerActor,
  effect: ToolEffect,
): boolean {
  if (callerActor.kind !== 'agent') return false;
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  if (policy === 'when_user_visible') {
    return (
      matchesAgentRef(callerActor.ref, 'copilot') || matchesAgentRef(callerActor.ref, 'teaching')
    );
  }
  // when_causal
  if (effect === 'propose' || effect === 'write') return true;
  return matchesAgentRef(callerActor.ref, 'dreaming');
}

export type SdkMcpServer = ReturnType<typeof createSdkMcpServer>;

export interface ToolExecutionGateInput {
  name: string;
  effect: ToolEffect;
}

export interface BuildMcpServerOptions {
  ctx: ToolContext;
  /** Logical name for the SDK MCP server; tools surface as `mcp__<name>__<tool>`. */
  serverName: string;
  /** Subset of registered DomainTool names to expose. */
  toolNames: readonly string[];
  /** `task_kind` recorded on each tool_call_log row (defaults to ctx.callerActor.ref). */
  taskKind?: string;
  /** Optional per-call runtime gate. Return a reason string to block execution. */
  beforeExecute?: (tool: ToolExecutionGateInput) => string | undefined;
}

/**
 * Build a per-request in-process MCP server that exposes the given subset of
 * registered DomainTools. Idempotently invokes `registerCoreTools()` so callers
 * don't need to remember to bootstrap.
 */
export function buildMcpServerFromRegistry(opts: BuildMcpServerOptions): SdkMcpServer {
  registerCoreTools();
  const { ctx, serverName, toolNames } = opts;
  const taskKind = opts.taskKind ?? ctx.callerActor.ref;

  const sdkTools = toolNames.map((name) => {
    const dt = getTool(name);
    if (!dt) {
      throw new Error(
        `buildMcpServerFromRegistry: tool '${name}' is not registered. Check src/server/ai/tools/bootstrap.ts.`,
      );
    }
    if (!(dt.inputSchema instanceof z.ZodObject)) {
      throw new Error(
        `buildMcpServerFromRegistry: tool '${name}' inputSchema must be a z.object(...). Got ${dt.inputSchema.constructor.name}.`,
      );
    }
    // SDK helper expects a ZodRawShape (`{ field: zodType, ... }`), not a
    // ZodObject. Extract the raw shape from the object schema.
    const rawShape = dt.inputSchema.shape as Record<string, z.ZodTypeAny>;

    return tool(dt.name, dt.description, rawShape, async (rawArgs) => {
      const startedAt = Date.now();
      let output: unknown = null;
      let errorReason: string | undefined;
      let summary = '';
      let parsedInput: unknown = rawArgs;

      try {
        parsedInput = dt.inputSchema.parse(rawArgs);
      } catch (err) {
        errorReason = err instanceof Error ? err.message : String(err);
      }

      if (errorReason === undefined) {
        try {
          const gateReason = opts.beforeExecute?.({ name: dt.name, effect: dt.effect });
          if (typeof gateReason === 'string' && gateReason.length > 0) {
            errorReason = gateReason;
          }
        } catch (err) {
          errorReason = err instanceof Error ? err.message : String(err);
        }
      }

      if (errorReason === undefined) {
        try {
          output = await dt.execute(ctx, parsedInput as never);
        } catch (err) {
          errorReason = err instanceof Error ? err.message : String(err);
        }
      }

      if (errorReason === undefined) {
        try {
          summary = dt.summarize(parsedInput as never, output as never);
        } catch (err) {
          const summaryError = err instanceof Error ? err.message : String(err);
          summary = `summary unavailable: ${summaryError}`;
          console.error('[mcp-bridge] tool summarize failed', {
            tool: dt.name,
            task_run_id: ctx.taskRunId,
            err,
          });
        }
      } else {
        summary = `error: ${errorReason}`;
      }

      const latencyMs = Date.now() - startedAt;
      let toolCallLogId: string | undefined;
      try {
        toolCallLogId = await writeToolCallLog(ctx.db, {
          task_run_id: ctx.taskRunId,
          task_kind: taskKind,
          tool_name: dt.name,
          effect: dt.effect,
          input_json: parsedInput as Record<string, unknown>,
          output_json: errorReason ? { error: errorReason } : (output as object | null),
          error_reason: errorReason,
          iteration: 0,
          latency_ms: latencyMs,
          cost: 0,
        });
      } catch (logErr) {
        // Logging must not break the tool loop. The SDK still gets a valid
        // result even if persistence fails.
        console.error('[mcp-bridge] writeToolCallLog failed', {
          tool: dt.name,
          task_run_id: ctx.taskRunId,
          err: logErr,
        });
      }

      // YUK-82: experimental:tool_use event mirror per mirrorEvent policy.
      // Schema (ToolUseExperimental) requires actor_kind='agent', so
      // user-fired calls never mirror regardless of the tool's policy.
      if (__resolveMirrorPolicy(dt.mirrorEvent, ctx.callerActor, dt.effect)) {
        const mirrorPayload: Record<string, unknown> = {
          tool_name: dt.name,
          args: (parsedInput ?? {}) as Record<string, unknown>,
        };
        if (summary) mirrorPayload.result_summary = summary;
        if (errorReason) mirrorPayload.error_reason = errorReason;

        const mirrorId = `tool_use_${createId()}`;
        try {
          await writeEvent(ctx.db, {
            id: mirrorId,
            session_id: null,
            actor_kind: 'agent',
            actor_ref: ctx.callerActor.ref,
            action: 'experimental:tool_use',
            subject_kind: 'query',
            subject_id: mirrorId,
            outcome: errorReason ? 'failure' : 'success',
            payload: mirrorPayload,
            caused_by_event_id: ctx.causedByEventId ?? null,
            task_run_id: ctx.taskRunId,
            cost_micro_usd: 0,
          });
          if (toolCallLogId) {
            try {
              await setToolCallLogMirroredEventId(ctx.db, toolCallLogId, mirrorId);
            } catch (linkErr) {
              console.error('[mcp-bridge] setToolCallLogMirroredEventId failed', {
                tool: dt.name,
                tcl_id: toolCallLogId,
                event_id: mirrorId,
                err: linkErr,
              });
            }
          }
        } catch (mirrorErr) {
          // Same principle — mirror failure must not crash the tool loop.
          console.error('[mcp-bridge] experimental:tool_use mirror writeEvent failed', {
            tool: dt.name,
            task_run_id: ctx.taskRunId,
            err: mirrorErr,
          });
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              errorReason ? { error: errorReason, summary } : { summary, output },
            ),
          },
        ],
      };
    });
  });

  return createSdkMcpServer({ name: serverName, tools: sdkTools });
}
