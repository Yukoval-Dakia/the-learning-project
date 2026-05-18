// AI task runner — Claude Agent SDK adapter.
//
// All paths go through @anthropic-ai/claude-agent-sdk's `query()` (spawned
// `claude` CLI subprocess, talked to over JSON-RPC). The SDK gives us:
//   - native tool-call loop with mcpServers / allowedTools
//   - PreToolUse / PostToolUse / SessionStart hook events
//   - SDKMemoryRecallMessage events (auto-memory + auto-dream)
//   - session persistence + resume
//
// We bypass:
//   - the Claude Code preset (we pass `systemPrompt: string` to replace it)
//   - the user's personal `~/.claude/` config (we set CLAUDE_CONFIG_DIR to
//     a fresh tmpdir per process so hooks/MCP/skills from dev machines
//     never leak into a server task)
//
// Per ANTHROPIC_BASE_URL env var the SDK transparently routes to xiaomi/mimo
// (Anthropic-protocol-compat). Model id ('mimo-v2.5-pro' / 'mimo-v2.5') is
// passed via the `model` option.
//
// Memory-layer extensibility:
//   - `RunTaskCtx.middleware: { beforeRun, afterRun }` — pre/post hooks
//     applied uniformly across runTask / runAgentTask / streamTask.
//     Memory module decorates input ahead of the model call and observes
//     output after.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TaskKind, tasks } from '@/ai/registry';
import { getTaskSystemPrompt } from '@/ai/task-prompts';
import type { Db } from '@/db/client';
import type { SubjectProfile } from '@/subjects/profile';
import {
  type Options,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages';
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
  /** Total cost in USD, as reported by the agent SDK. 0 when running
   *  against an endpoint that doesn't surface cost (xiaomi mimo). */
  cost_usd?: number;
}

export interface TaskMiddleware {
  /**
   * Called once before the model invocation. Can return a transformed
   * input (e.g. memory module prepends recall context).
   */
  beforeRun?: (kind: string, input: unknown, ctx: RunTaskCtx) => Promise<unknown> | unknown;
  /**
   * Called once with the resolved result. Side-effects only — observation
   * logging, memory write. Errors caught + logged, never thrown back.
   */
  afterRun?: (kind: string, result: RunTaskResult, ctx: RunTaskCtx) => Promise<void> | void;
}

export interface RunTaskCtx {
  db: Db;
  /** Only vision/ingestion paths use this; runTask itself doesn't dereference. */
  r2?: R2Client;
  /** Override provider/model for testing or per-call routing escapes. */
  override?: { provider?: ResolvedProvider['provider']; model?: string };
  /** Memory-layer hook surface. */
  middleware?: TaskMiddleware;
  /**
   * In-process MCP servers. Build with `createSdkMcpServer({ tools:
   * [tool(name, desc, schema, handler)] })`. Tools are referenced as
   * `mcp__<serverName>__<toolName>` in the registry's `allowedTools`.
   */
  mcpServers?: Options['mcpServers'];
  /**
   * Override allowedTools. When omitted, runner uses `tasks[kind].allowedTools`
   * from the registry — single source of truth for what each task can call.
   */
  allowedTools?: string[];
  /**
   * Optional subject context for profile-aware prompts. Omitted means current
   * default behavior: wenyan-first prompts.
   */
  subjectProfile?: SubjectProfile;
}

export type RunAgentTaskCtx = RunTaskCtx;
export type StreamTaskCtx = RunTaskCtx & {
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

function promptFromInput(input: unknown): string | AsyncIterable<SDKUserMessage> {
  if (isMultimodalTaskInput(input)) return multimodalPromptIterable(input);
  if (typeof input === 'string') return input;
  return JSON.stringify(input);
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
    base.ANTHROPIC_BASE_URL = '';
  }
  base.CLAUDE_CONFIG_DIR = getIsolatedClaudeConfigDir();
  base.CLAUDE_AGENT_SDK_CLIENT_APP = base.CLAUDE_AGENT_SDK_CLIENT_APP ?? 'loom/0.1';
  return base;
}

/**
 * Build the SDK query options for a task. Centralised so the 3 entry points
 * (runTask / runAgentTask / streamTask) stay consistent on permission mode,
 * config-dir isolation, tools-from-registry default, etc.
 */
function buildQueryOptions(
  kind: TaskKind,
  ctx: RunTaskCtx,
  abortController: AbortController,
): Options {
  const def = tasks[kind];
  const resolved = resolveTaskProvider(kind, ctx.override);
  const allowedTools = ctx.allowedTools ?? def.allowedTools;
  return {
    model: resolved.model,
    systemPrompt: getTaskSystemPrompt(kind, ctx.subjectProfile),
    abortController,
    env: buildAgentEnv(resolved),
    tools: allowedTools,
    mcpServers: ctx.mcpServers,
    maxTurns: def.budget.maxIterations || 1,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    cwd: process.cwd(),
  };
}

// ============================================================================
// runTask — default path. Goes through the Claude Agent SDK like the other
// entry points; tasks without `allowedTools` declared in registry just get
// an empty tool list and behave like a single-turn query.
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

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), def.budget.timeout);

  let resultText = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  let cost_usd: number | undefined;
  let stopReason = 'unknown';

  try {
    const q = sdkQuery({
      prompt: promptFromInput(actualInput),
      options: buildQueryOptions(kind, ctx, abortController),
    });
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

  // CostLedger: `cost_ledger.cost` is `real`, stored in USD (consistent
  // with /api/cost/today which sums + renders as $<spend>). Write the
  // raw USD float; do NOT multiply by 1e6.
  try {
    await writeCostLedger(ctx.db, {
      task_kind: kind,
      provider: resolved.provider,
      model: resolved.model,
      cost: cost_usd ?? 0,
      tokens_in: usage.inputTokens,
      tokens_out: usage.outputTokens,
    });
  } catch (err) {
    console.error('[runTask] writeCostLedger failed', { task_run_id: taskRunId, kind, err });
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
      console.error('[runTask] afterRun middleware failed', { task_run_id: taskRunId, kind, err });
    }
  }

  return result;
}

// ============================================================================
// runAgentTask — alias kept so callers that explicitly want the
// "I'm doing a tool-call loop, here's my MCP server" form can phrase intent.
// Behaviour is identical to runTask — pass ctx.mcpServers / ctx.allowedTools
// or let the registry's `allowedTools` apply.
// ============================================================================

export async function runAgentTask(
  kind: string,
  input: unknown,
  ctx: RunAgentTaskCtx,
): Promise<RunTaskResult> {
  return runTask(kind, input, ctx);
}

// ============================================================================
// streamTask — text-stream Response. Same SDK path; pipes assistant text
// deltas to the body. Tool-use blocks land in tool_call_log per turn.
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let usage = { inputTokens: 0, outputTokens: 0 };
      let cost_usd: number | undefined;
      let stopReason = 'unknown';
      let resultText = '';

      try {
        // beforeRun middleware applies to streaming too — memory context
        // should land before the first byte goes out.
        const actualInput = ctx.middleware?.beforeRun
          ? await ctx.middleware.beforeRun(kind, input, ctx)
          : input;

        const q = sdkQuery({
          prompt: promptFromInput(actualInput),
          options: buildQueryOptions(kind, ctx, abortController),
        });
        for await (const msg of q as AsyncIterable<SDKMessage>) {
          if (msg.type === 'assistant') {
            const text = extractAssistantText(msg);
            if (text) {
              controller.enqueue(encoder.encode(text));
              resultText += text;
            }
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
              usage = {
                inputTokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0),
                outputTokens: u?.output_tokens ?? 0,
              };
              cost_usd = msg.total_cost_usd;
              stopReason = msg.stop_reason ?? 'stop';
              try {
                await writeCostLedger(ctx.db, {
                  task_kind: kind,
                  provider: resolved.provider,
                  model: resolved.model,
                  // USD float; see runTask comment.
                  cost: cost_usd ?? 0,
                  tokens_in: usage.inputTokens,
                  tokens_out: usage.outputTokens,
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

        if (ctx.middleware?.afterRun) {
          try {
            await ctx.middleware.afterRun(
              kind,
              {
                task_run_id: taskRunId,
                text: resultText,
                finishReason: stopReason,
                usage,
                cost_usd,
              },
              ctx,
            );
          } catch (err) {
            console.error('[streamTask] afterRun middleware failed', {
              task_run_id: taskRunId,
              kind,
              err,
            });
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
