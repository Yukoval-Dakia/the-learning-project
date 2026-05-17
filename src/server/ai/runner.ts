// AI task runner — two-tier adapter:
//
//   - `runTask`  → @anthropic-ai/sdk direct HTTP. Fast (<100ms overhead),
//     no subprocess, no Claude Code harness baggage. Handles every
//     single-turn task currently registered (8/8).
//
//   - `runAgentTask` → @anthropic-ai/claude-agent-sdk via subprocess.
//     Used for tool-calling tasks (KnowledgeReviewTask, future Maintenance
//     / Coach agents). Spawns the bundled `claude` CLI; honours
//     mcpServers / allowedTools / hook events natively.
//
//   - `streamTask`  → returns a Response. Currently routes through the agent
//     SDK so Phase 1+ tool-calling endpoints work; single-turn tasks could
//     fall through to runTask + Response.json but we keep one path for
//     simplicity.
//
// Both runners share:
//   - Provider Manager via `resolveTaskProvider()` (xiaomi/mimo, anthropic).
//   - `RunTaskCtx.middleware`: { beforeRun?, afterRun? } — memory-layer
//     hook surface. Decorate inputs before the call, log observations after.
//   - cost_ledger writes.
//
// Migration note (2026-05-17): pre-this-file we used `@ai-sdk/anthropic`
// (Vercel AI SDK). That's been removed; this file is the only entry to the
// model layer.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TaskKind, tasks } from '@/ai/registry';
import type { Db } from '@/db/client';
import {
  type Options,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { createId } from '@paralleldrive/cuid2';
import type { R2Client } from '../r2';
import { writeCostLedger, writeToolCallLog } from './log';
import { type ResolvedProvider, resolveTaskProvider } from './providers';

// ============================================================================
// Public surface
// ============================================================================

export interface RunTaskResult {
  task_run_id: string;
  text: string;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Total cost in USD as reported by the agent SDK (subprocess path only);
   *  undefined when the call went through raw @anthropic-ai/sdk. */
  cost_usd?: number;
}

export interface TaskMiddleware {
  /**
   * Called once before the model invocation. Can return a transformed input
   * (e.g. memory module prepends "previously remembered: ..." context).
   */
  beforeRun?: (kind: string, input: unknown, ctx: RunTaskCtx) => Promise<unknown> | unknown;
  /**
   * Called once with the resolved result. Side-effects only — observation
   * logging, memory write. Errors are caught + logged, never thrown back.
   */
  afterRun?: (kind: string, result: RunTaskResult, ctx: RunTaskCtx) => Promise<void> | void;
}

export interface RunTaskCtx {
  db: Db;
  /** Only vision/ingestion paths use this; runTask itself doesn't dereference. */
  r2?: R2Client;
  /** Override provider/model for testing or per-call routing escapes. */
  override?: { provider?: ResolvedProvider['provider']; model?: string };
  /** Memory-layer hook surface (Phase 3 extensibility point). */
  middleware?: TaskMiddleware;
}

export interface RunAgentTaskCtx extends RunTaskCtx {
  /**
   * In-process MCP servers. Build with `createSdkMcpServer({ tools:
   * [tool(name, desc, schema, handler)] })`. Tools are then referenced as
   * `mcp__<serverName>__<toolName>` in `allowedTools`.
   */
  mcpServers?: Options['mcpServers'];
  /** Tools the model may use this call. Defaults to []  — no tools at all. */
  allowedTools?: string[];
}

export type StreamTaskCtx = RunAgentTaskCtx & {
  /** Reserved for back-compat with the old Vercel AI SDK shape; ignored. */
  tools?: Record<string, unknown>;
};

export interface MultimodalTaskInput {
  text: string;
  images: Array<{
    /** base64-encoded image data (no "data:" prefix), URL, or Buffer-like. */
    data: string | URL | Uint8Array;
    mediaType: string;
  }>;
}

// ============================================================================
// Internals
// ============================================================================

const TASK_KINDS = Object.keys(tasks) as TaskKind[];

function isKnownTask(k: string): k is TaskKind {
  return (TASK_KINDS as string[]).includes(k);
}

function isMultimodalTaskInput(input: unknown): input is MultimodalTaskInput {
  if (input == null || typeof input !== 'object') return false;
  const candidate = input as { text?: unknown; images?: unknown };
  return (
    typeof candidate.text === 'string' &&
    Array.isArray(candidate.images) &&
    candidate.images.every((image) => {
      const img = image as { data?: unknown; mediaType?: unknown };
      return (
        img.data != null && typeof img.mediaType === 'string' && img.mediaType.startsWith('image/')
      );
    })
  );
}

function imageDataToBase64(data: MultimodalTaskInput['images'][number]['data']): string {
  if (data instanceof URL) return data.toString();
  if (typeof data === 'string') return data;
  return Buffer.from(data).toString('base64');
}

function buildMessageParams(input: unknown): MessageParam[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (isMultimodalTaskInput(input)) {
    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: input.text },
          ...input.images.map((img) => {
            const data = imageDataToBase64(img.data);
            if (data.startsWith('http://') || data.startsWith('https://')) {
              return {
                type: 'image' as const,
                source: { type: 'url' as const, url: data },
              };
            }
            return {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: img.mediaType as
                  | 'image/jpeg'
                  | 'image/png'
                  | 'image/gif'
                  | 'image/webp',
                data,
              },
            };
          }),
        ],
      },
    ];
  }
  return [{ role: 'user', content: JSON.stringify(input) }];
}

// Memoised isolated CLAUDE_CONFIG_DIR. The agent SDK reads `~/.claude/` by
// default for hooks/MCP/skills; in a server we need a clean empty dir so
// the subprocess can't pull in the developer's personal Claude config.
let isolatedConfigDir: string | undefined;
function getIsolatedClaudeConfigDir(): string {
  if (!isolatedConfigDir) {
    isolatedConfigDir = mkdtempSync(join(tmpdir(), 'loom-claude-'));
  }
  return isolatedConfigDir;
}

function buildAgentEnv(resolved: ResolvedProvider): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') base[k] = v;
  }
  base.ANTHROPIC_API_KEY = resolved.apiKey;
  if (resolved.baseUrl) {
    base.ANTHROPIC_BASE_URL = resolved.baseUrl;
  } else {
    // Empty string is treated as unset by the SDK's URL parser; avoids using
    // `delete` (lint flags it).
    base.ANTHROPIC_BASE_URL = '';
  }
  base.CLAUDE_CONFIG_DIR = getIsolatedClaudeConfigDir();
  base.CLAUDE_AGENT_SDK_CLIENT_APP = base.CLAUDE_AGENT_SDK_CLIENT_APP ?? 'loom/0.1';
  return base;
}

// ============================================================================
// runTask — direct @anthropic-ai/sdk call. Default path; no tools, no agent.
// ============================================================================

export async function runTask(
  kind: string,
  input: unknown,
  ctx: RunTaskCtx,
): Promise<RunTaskResult> {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];
  const taskRunId = createId();
  const resolved = resolveTaskProvider(kind, ctx.override);

  const actualInput = ctx.middleware?.beforeRun
    ? await ctx.middleware.beforeRun(kind, input, ctx)
    : input;

  const client = new Anthropic({
    apiKey: resolved.apiKey,
    ...(resolved.baseUrl ? { baseURL: resolved.baseUrl } : {}),
  });

  const messages = buildMessageParams(actualInput);

  const response = await client.messages.create(
    {
      model: resolved.model,
      max_tokens: 4096,
      system: def.systemPrompt,
      messages,
    },
    {
      timeout: def.budget.timeout,
    },
  );

  let resultText = '';
  for (const block of response.content) {
    if (block.type === 'text') resultText += block.text;
  }

  const usage = {
    inputTokens: (response.usage.input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0),
    outputTokens: response.usage.output_tokens ?? 0,
  };

  try {
    await writeCostLedger(ctx.db, {
      task_kind: kind,
      provider: resolved.provider,
      model: resolved.model,
      cost: 0,
      tokens_in: usage.inputTokens,
      tokens_out: usage.outputTokens,
    });
  } catch (err) {
    console.error('[runTask] writeCostLedger failed', { task_run_id: taskRunId, kind, err });
  }

  const result: RunTaskResult = {
    task_run_id: taskRunId,
    text: resultText,
    finishReason: response.stop_reason ?? 'unknown',
    usage,
  };

  if (ctx.middleware?.afterRun) {
    try {
      await ctx.middleware.afterRun(kind, result, ctx);
    } catch (err) {
      console.error('[runTask] afterRun middleware failed', { task_run_id: taskRunId, kind, err });
    }
  }

  return result;
}

// ============================================================================
// runAgentTask — @anthropic-ai/claude-agent-sdk subprocess.
// Use this when the task needs tool-calling (mcpServers + allowedTools) or
// will hook into SDK lifecycle events (PreToolUse / PostToolUse / etc.).
// ============================================================================

export async function runAgentTask(
  kind: string,
  input: unknown,
  ctx: RunAgentTaskCtx,
): Promise<RunTaskResult> {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];
  const taskRunId = createId();
  const resolved = resolveTaskProvider(kind, ctx.override);

  const actualInput = ctx.middleware?.beforeRun
    ? await ctx.middleware.beforeRun(kind, input, ctx)
    : input;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), def.budget.timeout);

  const queryOptions: Options = {
    model: resolved.model,
    systemPrompt: def.systemPrompt,
    abortController,
    env: buildAgentEnv(resolved),
    tools: ctx.allowedTools ?? [],
    mcpServers: ctx.mcpServers,
    maxTurns: def.budget.maxIterations || 1,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    cwd: process.cwd(),
  };

  let resultText = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  let cost_usd: number | undefined;
  let stopReason = 'unknown';

  try {
    const promptArg = isMultimodalTaskInput(actualInput)
      ? multimodalPromptIterable(actualInput)
      : typeof actualInput === 'string'
        ? actualInput
        : JSON.stringify(actualInput);
    const q = sdkQuery({ prompt: promptArg, options: queryOptions });

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          resultText = msg.result ?? '';
          const u = msg.usage;
          usage = {
            inputTokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0),
            outputTokens: u?.output_tokens ?? 0,
          };
          cost_usd = msg.total_cost_usd;
          stopReason = msg.stop_reason ?? 'stop';
        } else {
          const apiStatus =
            'api_error_status' in msg && msg.api_error_status
              ? ` http=${msg.api_error_status}`
              : '';
          throw new Error(`[${kind}] Agent SDK errored: subtype=${msg.subtype}${apiStatus}`);
        }
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  try {
    await writeCostLedger(ctx.db, {
      task_kind: kind,
      provider: resolved.provider,
      model: resolved.model,
      cost: Math.round((cost_usd ?? 0) * 1_000_000),
      tokens_in: usage.inputTokens,
      tokens_out: usage.outputTokens,
    });
  } catch (err) {
    console.error('[runAgentTask] writeCostLedger failed', {
      task_run_id: taskRunId,
      kind,
      err,
    });
  }

  const result: RunTaskResult = {
    task_run_id: taskRunId,
    text: resultText,
    finishReason: stopReason,
    usage,
    cost_usd,
  };

  if (ctx.middleware?.afterRun) {
    try {
      await ctx.middleware.afterRun(kind, result, ctx);
    } catch (err) {
      console.error('[runAgentTask] afterRun middleware failed', {
        task_run_id: taskRunId,
        kind,
        err,
      });
    }
  }

  return result;
}

async function* multimodalPromptIterable(
  input: MultimodalTaskInput,
): AsyncGenerator<SDKUserMessage> {
  const userMessage: SDKUserMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: input.text },
        ...input.images.map((img) => {
          const data = imageDataToBase64(img.data);
          if (data.startsWith('http://') || data.startsWith('https://')) {
            return {
              type: 'image' as const,
              source: { type: 'url' as const, url: data },
            };
          }
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data,
            },
          };
        }),
      ],
    },
  };
  yield userMessage;
}

// ============================================================================
// streamTask — Response wrapper. Routes through the agent SDK so future
// tool-calling clients (Copilot drawer, /api/ai/[task] for needsToolCall
// tasks) inherit the full subprocess capabilities. Pure-stream single-turn
// callers could go directly via Anthropic SDK; we keep one path here.
// ============================================================================

export function streamTask(kind: string, input: unknown, ctx: StreamTaskCtx): Response {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];
  const taskRunId = createId();
  const resolved = resolveTaskProvider(kind, ctx.override);
  let stepStartTime = Date.now();
  let iteration = 0;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), def.budget.timeout);

  const promptArg = isMultimodalTaskInput(input)
    ? multimodalPromptIterable(input)
    : typeof input === 'string'
      ? input
      : JSON.stringify(input);

  const queryOptions: Options = {
    model: resolved.model,
    systemPrompt: def.systemPrompt,
    abortController,
    env: buildAgentEnv(resolved),
    tools: ctx.allowedTools ?? [],
    mcpServers: ctx.mcpServers,
    maxTurns: def.budget.maxIterations,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    cwd: process.cwd(),
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        const q = sdkQuery({ prompt: promptArg, options: queryOptions });
        for await (const msg of q as AsyncIterable<SDKMessage>) {
          if (msg.type === 'assistant') {
            const text = extractAssistantText(msg);
            if (text) controller.enqueue(encoder.encode(text));
            iteration += 1;
            const stepLatencyMs = Date.now() - stepStartTime;
            const blocks = (msg.message.content ?? []) as ContentBlock[];
            for (const block of blocks) {
              if (block.type === 'tool_use') {
                try {
                  await writeToolCallLog(ctx.db, {
                    task_run_id: taskRunId,
                    task_kind: kind,
                    tool_name: block.name,
                    input_json: (block.input ?? {}) as Record<string, unknown>,
                    output_json: {},
                    iteration,
                    latency_ms: stepLatencyMs,
                    cost: 0,
                  });
                } catch (err) {
                  console.error('[streamTask] writeToolCallLog failed', {
                    task_run_id: taskRunId,
                    kind,
                    tool: block.name,
                    err,
                  });
                }
              }
            }
            stepStartTime = Date.now();
          } else if (msg.type === 'result') {
            if (msg.subtype === 'success') {
              const u = msg.usage;
              try {
                await writeCostLedger(ctx.db, {
                  task_kind: kind,
                  provider: resolved.provider,
                  model: resolved.model,
                  cost: Math.round((msg.total_cost_usd ?? 0) * 1_000_000),
                  tokens_in: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0),
                  tokens_out: u?.output_tokens ?? 0,
                });
              } catch (err) {
                console.error('[streamTask] writeCostLedger failed', {
                  task_run_id: taskRunId,
                  kind,
                  err,
                });
              }
            }
            break;
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? `[streamTask] ${err.message}` : '[streamTask] unknown error';
        controller.enqueue(new TextEncoder().encode(`\n\n${message}\n`));
      } finally {
        clearTimeout(timer);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}

function extractAssistantText(msg: SDKAssistantMessage): string {
  let out = '';
  const blocks = (msg.message.content ?? []) as ContentBlock[];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}
