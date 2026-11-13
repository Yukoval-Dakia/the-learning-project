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
import {
  type FailureDiagnostics,
  annotateFailure,
  failureDiagnostics,
} from '@/ai/failure-diagnostics';
import { type BuildMcpServerOptions, type PiToolMount, piToolWireName } from '@/ai/pi-tool-mount';
import { writeToolCallLog, writeUnpricedToolCost } from '@/kernel/tools/call-evidence';
import {
  ensureToolParametersObjectRoot,
  zodToToolParametersSchema,
} from '@/kernel/zod-json-schema';
import type { ExecutionAdapterStartupArgs } from '../execution-adapter';
import { isPrivateTraceContent } from '../laminar-tracing';
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
      effect: dt.effect,
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
    } satisfies AgentTool & { effect: typeof dt.effect };
  });
}

/** Lifecycle handle for a mounted remote MCP server — owned per prepared query. */
export interface PiRemoteMcpMountHandle {
  tools: AgentTool[];
  close(): Promise<void>;
}

// Optional search must not hold a learner's reply hostage, but the limit is a
// hang guard, not a way to save time (owner 2026-11-07, YUK-1983): TEST's
// unreachable endpoint took about 10–12s to fail (#2632), leaving zero margin
// for a merely slow handshake — the run then degrades and loses search. 30s is
// ~2.5× that observed worst failure latency; a working handshake measures
// ~1–2s (YUK-1983 dev probes). Share this budget across connect and tools/list.
const OPTIONAL_SEARCH_STARTUP_TIMEOUT_MS = 30_000;

function isOptionalSearch(mount: Extract<PiToolMount, { type: 'remote-mcp' }>, kind?: string) {
  return kind === 'CopilotTask' && mount.serverName === 'exa' && mount.optional === true;
}

/**
 * Bridge a hosted MCP server into pi AgentTools. The client connects at startup so
 * `tools/list` failures surface before any paid token. Required mounts rethrow;
 * `connectTaskRemoteMcp` catches the Copilot optional Exa search instead.
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
  let stage: 'remote_mcp_connect' | 'remote_mcp_list_tools' | 'remote_mcp_schema' =
    'remote_mcp_connect';
  const deadline = isOptionalSearch(mount, run?.taskKind)
    ? Date.now() + OPTIONAL_SEARCH_STARTUP_TIMEOUT_MS
    : undefined;
  const startupAbort = deadline === undefined ? undefined : new AbortController();
  const timeoutError = Object.assign(new Error('Optional search startup timed out'), {
    name: 'TimeoutError',
    code: 'ETIMEDOUT',
  });
  let closing: Promise<void> | undefined;
  const timer =
    deadline === undefined
      ? undefined
      : setTimeout(
          () => {
            startupAbort?.abort(timeoutError);
            // Closing the transport aborts fetches as well as the SDK's pending RPCs.
            closing = client
              .close()
              .catch(() => transport.close())
              .catch(() => {});
          },
          Math.max(0, deadline - Date.now()),
        );
  const startupOptions = () =>
    deadline === undefined
      ? undefined
      : {
          signal: startupAbort?.signal,
          timeout: Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
        };
  try {
    // Connect AND list inside the same cleanup scope so a transport failure
    // still releases the client socket.
    await client.connect(transport, { timeout: timeoutMs, ...startupOptions() });
    if (deadline !== undefined && Date.now() >= deadline) throw timeoutError;
    stage = 'remote_mcp_list_tools';
    const listed = await client.listTools(undefined, startupOptions());
    if (deadline !== undefined && Date.now() >= deadline) throw timeoutError;
    stage = 'remote_mcp_schema';
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
              const privateContent = isPrivateTraceContent();
              try {
                await writeToolCallLog(mount.db, {
                  task_run_id: run.taskRunId,
                  task_kind: run.taskKind,
                  tool_name: wireName,
                  effect: 'read',
                  input_json: privateContent
                    ? { content_omitted: true }
                    : ((params ?? {}) as Record<string, unknown>),
                  output_json: privateContent ? { content_omitted: true } : output,
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
                  err: privateContent ? 'private_tool_log_failed' : logErr,
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
    const failure = startupAbort?.signal.aborted ? timeoutError : err;
    annotateFailure(failure, stage, new URL(mount.config.url).hostname);
    await (closing ??
      client
        .close()
        .catch(() => transport.close())
        .catch(() => {}));
    throw failure;
  } finally {
    clearTimeout(timer);
    await closing;
  }
}

// The same mount descriptor survives provider retries; a new logical run creates another.
const unavailableSearchMounts = new WeakMap<PiToolMount, FailureDiagnostics>();

export async function connectTaskRemoteMcp(
  mount: Extract<PiToolMount, { type: 'remote-mcp' }>,
  startup: Pick<ExecutionAdapterStartupArgs, 'kind' | 'runId' | 'initializeTimeoutMs' | 'options'>,
  connect: typeof connectPiRemoteMcp,
): Promise<PiRemoteMcpMountHandle | undefined> {
  const optionalSearch = isOptionalSearch(mount, startup.kind);
  let unavailable = optionalSearch ? unavailableSearchMounts.get(mount) : undefined;
  if (!unavailable) {
    try {
      const handle = await connect(mount, startup.initializeTimeoutMs, {
        taskRunId: startup.runId,
        taskKind: startup.kind,
      });
      // Positive evidence for the dependency streak: a run that mounted web
      // search and reached the handshake ends a failure streak even when the
      // model call itself fails afterwards.
      if (optionalSearch) {
        startup.options.transportEvidence?.noteOptionalDependencyConnected('web_search');
      }
      return handle;
    } catch (error) {
      const diagnostics = failureDiagnostics(error);
      if (
        !optionalSearch ||
        (diagnostics.stage !== 'remote_mcp_connect' &&
          diagnostics.stage !== 'remote_mcp_list_tools')
      )
        throw error;
      unavailable = diagnostics;
      unavailableSearchMounts.set(mount, diagnostics);
      console.warn('[pi-adapter] optional_search_unavailable', {
        task_run_id: startup.runId,
        ...diagnostics,
      });
    }
  }
  if (unavailable) {
    startup.options.transportEvidence?.noteOptionalDependencyFailure('web_search', unavailable);
  }
  return undefined;
}
