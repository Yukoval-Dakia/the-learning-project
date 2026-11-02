// YUK-921 P2 (YUK-1021) — the pi-side tool mount surface.
//
//   - 'domain'     — registry DomainTools compiled into pi AgentTools; execute
//     delegates to `executeDomainToolCall`, so logging, mirroring, gates, output
//     validation and summarize stay one pipeline.
//   - 'remote-mcp' — hosted MCP servers (Exa today) bridged through the MCP SDK
//     client. `listTools` JSON Schema is passed to pi verbatim.
//
// Wire naming: `mcp__<serverName>__<tool>` everywhere, so recordToolCall,
// allowedTools filtering and mirror policy see one name space.
//
// pi hands `execute()` the native toolCall.id, so the mount passes it straight
// through as `correlatedToolUseId`.

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { type BuildMcpServerOptions, type PiToolMount, piToolWireName } from '@/ai/pi-tool-mount';
import { writeToolCallLog, writeUnpricedToolCost } from '@/kernel/tools/call-evidence';
import {
  ensureToolParametersObjectRoot,
  zodToToolParametersSchema,
} from '@/kernel/zod-json-schema';
import { executeDomainToolCall } from './mcp-bridge';
import { getTool } from './registry';

/**
 * Compile registry DomainTools into pi AgentTools. pi validates raw arguments
 * against `parameters`, then the shared pipeline zod-parses again for the typed
 * value — the same defence in depth as the direct bridge.
 */
export function buildPiDomainAgentTools(options: BuildMcpServerOptions): AgentTool[] {
  return options.toolNames.map((name) => {
    const dt = getTool(name);
    if (!dt) {
      throw new Error(
        `buildPiDomainAgentTools: tool '${name}' is not registered. Check capability manifest registration.`,
      );
    }
    if (!(dt.inputSchema instanceof z.ZodObject)) {
      throw new Error(
        `buildPiDomainAgentTools: tool '${name}' inputSchema must be a z.object(...). Got ${dt.inputSchema.constructor.name}.`,
      );
    }
    const parameters = zodToToolParametersSchema(dt.inputSchema, {
      io: 'input',
      reused: 'inline',
      target: 'draft-07',
    }) as AgentTool['parameters'];

    return {
      name: piToolWireName(options.serverName, dt.name),
      label: dt.name,
      description: dt.description,
      parameters,
      execute: async (toolCallId, params, signal) => {
        // The loop abort must reach the tool: merge it with the caller's
        // ctx.signal so either source cancels execution.
        const signals = [options.ctx.signal, signal].filter(
          (s): s is AbortSignal => s !== undefined,
        );
        const toolSignal =
          signals.length === 0
            ? undefined
            : signals.length === 1
              ? signals[0]
              : AbortSignal.any(signals);
        const result = await executeDomainToolCall(dt, params, {
          ...options,
          ctx: { ...options.ctx, ...(toolSignal ? { signal: toolSignal } : {}) },
          correlatedToolUseId: toolCallId,
          cancellationSignals: [
            ...(options.cancellationSignals ?? []),
            ...(signal ? [{ signal, requestedBy: 'system' as const }] : []),
          ],
        });
        // YUK-1559 — forward the bridge's failure flag: pi marks tool_result
        // isError from it without throwing (which would discard content/details).
        return {
          content: result.content,
          details: null,
          isError: result.isError,
        } satisfies AgentToolResult<null>;
      },
    } satisfies AgentTool;
  });
}

/** Lifecycle handle for a mounted remote MCP server — owned per prepared query. */
export interface PiRemoteMcpMountHandle {
  tools: AgentTool[];
  close(): Promise<void>;
}

/**
 * Bridge a hosted MCP server into pi AgentTools. The client connects at startup so
 * `tools/list` failures surface before any paid token.
 */
export async function connectPiRemoteMcp(
  mount: Extract<PiToolMount, { type: 'remote-mcp' }>,
  timeoutMs: number,
  run?: { taskRunId: string; taskKind: string },
): Promise<PiRemoteMcpMountHandle> {
  // Dynamic imports keep the migrate bundle free of the MCP client (same boundary
  // as the pi packages: build:migrate marks them external).
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const client = new Client({ name: 'loom-pi-adapter', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mount.config.url), {
    requestInit: { headers: mount.config.headers ?? {} },
  });
  try {
    // Connect AND list inside the same cleanup scope so a transport failure
    // still releases the client socket.
    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools();
    const wanted = new Set(mount.toolNames);
    const tools = listed.tools
      .filter((remote) => wanted.has(remote.name))
      .map((remote): AgentTool => {
        // MCP inputSchema is already plain JSON Schema. The object-root contract
        // still applies (YUK-1547): normalize it or fail the mount loudly rather
        // than let the provider 400 mid-run.
        let parameters: AgentTool['parameters'];
        try {
          parameters = ensureToolParametersObjectRoot(
            (remote.inputSchema ?? {
              type: 'object',
              properties: {},
            }) as Record<string, unknown>,
          ) as AgentTool['parameters'];
        } catch (error) {
          throw new Error(
            `remote MCP tool '${mount.serverName}/${remote.name}' declares parameters whose root is not type:"object": ${error instanceof Error ? error.message : String(error)} — fix the remote server's inputSchema or drop the tool from the mount.`,
          );
        }
        return {
          name: piToolWireName(mount.serverName, remote.name),
          label: remote.name,
          description: remote.description ?? '',
          parameters,
          execute: async (_toolCallId, params) => {
            const startedAt = Date.now();
            const wireName = piToolWireName(mount.serverName, remote.name);
            const record = async (
              output: Record<string, unknown>,
              errorReason?: string,
            ): Promise<void> => {
              if (!mount.db || !run) return;
              try {
                await writeToolCallLog(mount.db, {
                  task_run_id: run.taskRunId,
                  task_kind: run.taskKind,
                  tool_name: wireName,
                  effect: 'read',
                  input_json: (params ?? {}) as Record<string, unknown>,
                  output_json: output,
                  ...(errorReason ? { error_reason: errorReason } : {}),
                  iteration: 0,
                  latency_ms: Date.now() - startedAt,
                  // Per the tool_call_log contract this column is not a cost
                  // ledger; the unknown-price attempt row below carries it.
                  cost: 0,
                });
                await writeUnpricedToolCost(mount.db, {
                  taskRunId: run.taskRunId,
                  provider: mount.serverName,
                  toolName: remote.name,
                  outcome: errorReason ? 'failed_permanent' : 'success',
                });
              } catch (logErr) {
                // Bookkeeping must not turn a completed remote read into a failure.
                console.error('[pi-tools] remote MCP tool log failed', {
                  tool: wireName,
                  task_run_id: run.taskRunId,
                  err: logErr,
                });
              }
            };
            const res = (await client
              .callTool({
                name: remote.name,
                arguments: params as Record<string, unknown>,
              })
              .catch(async (err: unknown) => {
                await record(
                  { error: err instanceof Error ? err.message : String(err) },
                  'remote_mcp_call_failed',
                );
                throw err;
              })) as {
              content?: Array<{ type: string; text?: string }>;
              isError?: boolean;
            };
            const content = (res.content ?? []).flatMap((block) =>
              block.type === 'text' && typeof block.text === 'string'
                ? [{ type: 'text' as const, text: block.text }]
                : [],
            );
            if (res.isError) {
              // SDK parity: an isError MCP result becomes an error tool result (pi
              // marks errors by throwing), carrying the content so the model sees it.
              await record(
                { content: content.length > 0 ? content : (res.content ?? res) },
                'remote_mcp_is_error',
              );
              throw new Error(JSON.stringify(content.length > 0 ? content : (res.content ?? res)));
            }
            const resultContent =
              content.length > 0 ? content : [{ type: 'text' as const, text: JSON.stringify(res) }];
            await record({ content: resultContent });
            return {
              content: resultContent,
              details: null,
            } satisfies AgentToolResult<null>;
          },
        };
      });
    return { tools, close: () => client.close() };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}
