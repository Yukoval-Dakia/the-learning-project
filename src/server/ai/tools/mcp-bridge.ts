// YUK-81 / Foundation D M1 Lane C
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
//   4. return an MCP-shaped { content: [{ type: 'text', text: <json> }] }
//      result the LLM can read.
//
// Lane C deliberately does NOT yet write the `experimental:tool_use` event
// mirror — that's Lane D (it requires mirrorEvent policy resolution + caller
// actor introspection). The tool_call_log row already captures the run; the
// mirror is the user-facing audit surface.

import { writeToolCallLog } from '@/server/ai/log';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { registerCoreTools } from './bootstrap';
import { getTool } from './registry';
import type { ToolContext } from './types';

export type SdkMcpServer = ReturnType<typeof createSdkMcpServer>;

export interface BuildMcpServerOptions {
  ctx: ToolContext;
  /** Logical name for the SDK MCP server; tools surface as `mcp__<name>__<tool>`. */
  serverName: string;
  /** Subset of registered DomainTool names to expose. */
  toolNames: readonly string[];
  /** `task_kind` recorded on each tool_call_log row (defaults to ctx.callerActor.ref). */
  taskKind?: string;
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
        output = await dt.execute(ctx, parsedInput as never);
        summary = dt.summarize(parsedInput as never, output as never);
      } catch (err) {
        errorReason = err instanceof Error ? err.message : String(err);
        summary = `error: ${errorReason}`;
      }

      const latencyMs = Date.now() - startedAt;
      try {
        await writeToolCallLog(ctx.db, {
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
