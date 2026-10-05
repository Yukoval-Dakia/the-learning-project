// YUK-921 P2 (YUK-1021) — the pi-side tool mount surface.
//
// Two mount kinds feed `AgentContext.tools` on the pi lane:
//
//   - 'domain'      — DomainTools from the registry, compiled into pi
//     `AgentTool`s. The execute body delegates to the SAME
//     `executeDomainToolCall` pipeline the SDK mcp-bridge wraps, so
//     tool_call_log / tool_use mirror / beforeExecute gates /
//     interceptInput / output-schema enforcement / summarize are
//     byte-identical between engines.
//   - 'remote-mcp'  — hosted MCP servers (Exa today), bridged through a real
//     `@modelcontextprotocol/sdk` client. `listTools` at mount-build time
//     gives us each remote tool's JSON Schema verbatim — pi's
//     `validateToolArguments` accepts plain JSON Schema (non-TypeBox path),
//     so no schema translation is needed on this side either.
//
// Wire naming parity: pi AgentTool names are `mcp__<serverName>__<tool>` —
// exactly what the SDK subprocess puts on assistant tool_use blocks. That
// single choice makes runner-side `recordToolCall`, `allowedTools`
// filtering, `shouldEmitToolUseForCaller` and every downstream consumer see
// identical names on both engines.
//
// Correlation: the SDK path needed createToolUseCorrelation's PreToolUse
// hook to learn the tool_use_id. Pi hands `execute()` the native
// toolCall.id, so the pi mount simply passes it as `correlatedToolUseId` —

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { zodToJsonSchemaCompat } from '@/kernel/zod-json-schema';
import { type BuildMcpServerOptions, executeDomainToolCall } from './mcp-bridge';
import { getTool } from './registry';

/** Namespaced wire name — identical to the SDK's `mcp__<server>__<tool>` convention. */
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
    }
  | {
      type: 'custom';
      /**
       * Escape hatch for tools that are NOT registered DomainTools — e.g.
       * KnowledgeReviewTask's bespoke `write_proposal`, the agency evidence /
       * director servers. The caller owns the AgentTool's execute body and
       * must keep its logging semantics identical to the domain bridge.
       */
      tools: AgentTool[];
    };

/** Convenience constructor for a domain mount descriptor. */
export function piDomainMount(options: BuildMcpServerOptions): PiToolMount {
  return { type: 'domain', options };
}

/**
 * Build one bespoke `AgentTool` for a `custom` mount — used by hand-rolled
 * tool sets (evidence/director/review). Wire name is `mcp__<server>__<name>`;
 * the zod raw shape compiles through the same zodToJsonSchemaCompat path as
 * the domain bridge; the handler returns the MCP-shaped `{content}` payload.
 */
export function piCustomTool(
  serverName: string,
  name: string,
  description: string,
  schema: Record<string, z.ZodTypeAny>,
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: 'text'; text: string }[] }>,
): AgentTool {
  return {
    name: piToolWireName(serverName, name),
    label: name,
    description,
    parameters: zodToJsonSchemaCompat(z.object(schema), {
      io: 'input',
      reused: 'inline',
      target: 'draft-07',
    }) as AgentTool['parameters'],
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
): PiToolMount {
  return { type: 'remote-mcp', serverName, config, toolNames };
}

/**
 * Compile the registry's DomainTools into pi AgentTools. Validation order on
 * a call is the same double-layer the SDK path uses: pi validates the raw
 * arguments against `parameters` (plain JSON Schema from
 * zodToJsonSchemaCompat), then the shared pipeline zod-parses again for the
 * typed Input value — identical defence in depth.
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
    const parameters = zodToJsonSchemaCompat(dt.inputSchema, {
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
        // The in-process loop abort must reach the tool the way the SDK
        // subprocess kill reached it — merge the loop signal with the
        // caller-owned ctx.signal so either source cancels execution.
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
        return { content: result.content, details: null } satisfies AgentToolResult<null>;
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
 * Bridge a hosted MCP server into pi AgentTools (~the design's "mcp-bridge.ts
 * 反向"). The client connects at startup so `tools/list` failures surface
 * before any paid token — a misconfigured remote mount fails the run loudly
 * instead of silently running tool-less.
 */
export async function connectPiRemoteMcp(
  mount: Extract<PiToolMount, { type: 'remote-mcp' }>,
  timeoutMs: number,
): Promise<PiRemoteMcpMountHandle> {
  // Dynamic imports keep the migrate bundle free of the MCP client (the same
  // boundary as the pi packages — build:migrate marks these external and the
  // import only evaluates when a pi tool-loop run actually starts).
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const client = new Client({ name: 'loom-pi-adapter', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mount.config.url), {
    requestInit: { headers: mount.config.headers ?? {} },
  });
  try {
    // Connect AND list inside the same cleanup scope — a transport failure
    // must still release the client socket.
    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools();
    const wanted = new Set(mount.toolNames);
    const tools = listed.tools
      .filter((remote) => wanted.has(remote.name))
      .map(
        (remote): AgentTool => ({
          name: piToolWireName(mount.serverName, remote.name),
          label: remote.name,
          description: remote.description ?? '',
          // MCP tool inputSchema is already plain JSON Schema — pi validates
          // it through the non-TypeBox path, no translation needed.
          parameters: (remote.inputSchema ?? {
            type: 'object',
            properties: {},
          }) as AgentTool['parameters'],
          execute: async (_toolCallId, params) => {
            const res = (await client.callTool({
              name: remote.name,
              arguments: params as Record<string, unknown>,
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
              // SDK parity: an isError MCP result becomes an error tool
              // result. Pi marks errors via a thrown execute — carry the
              // serialized content so the model still sees the payload.
              throw new Error(JSON.stringify(content.length > 0 ? content : (res.content ?? res)));
            }
            return {
              content:
                content.length > 0
                  ? content
                  : [{ type: 'text' as const, text: JSON.stringify(res) }],
              details: null,
            } satisfies AgentToolResult<null>;
          },
        }),
      );
    return { tools, close: () => client.close() };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}
