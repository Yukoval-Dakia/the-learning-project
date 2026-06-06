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

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
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
import {
  writeAiTaskRunFinished,
  writeAiTaskRunStarted,
  writeCostLedger,
  writeToolCallLog,
} from './log';
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
  /** Subject context for prompts that are rendered from SubjectProfile. */
  subjectProfile?: SubjectProfile;
  /**
   * YUK-225 (S2 slice 4) — Agent Skill whitelist threaded to `Options.skills`.
   * Names match a SKILL.md `name` / directory under src/subjects/<id>/skills/
   * (e.g. ['quiz-gen-translation']). When set, ONLY these skills are loaded into
   * the model's listing (SDK context filter); when omitted, no skills option is
   * passed (current behaviour — the降级链 falls back to promptFragments).
   *
   * The SoT lives in src/subjects/<id>/skills/; the runner populates the isolated
   * CLAUDE_CONFIG_DIR/skills once at process start (getIsolatedClaudeConfigDir),
   * and this array keys WHICH of the populated skills the model actually sees. Per
   * the YUK-217 spike, `settingSources` must stay OMITTED — passing `[]` disables
   * the CONFIG_DIR/skills auto-load and the populated skills become invisible.
   */
  skills?: string[];
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

function stableInputForHash(value: unknown): unknown {
  if (value instanceof URL) return value.toString();
  if (value instanceof Uint8Array) return { _type: 'bytes', byteLength: value.byteLength };
  if (Array.isArray(value)) return value.map(stableInputForHash);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableInputForHash((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function inputHash(input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(stableInputForHash(input)) ?? 'null';
  } catch {
    serialized = String(input);
  }
  return createHash('sha256').update(serialized).digest('hex');
}

// Memoised isolated CLAUDE_CONFIG_DIR. The agent SDK reads `~/.claude/` by
// default for hooks/MCP/skills; in a server we need a clean empty dir so
// the subprocess can't pull in the developer's personal Claude config.
//
// YUK-225 (S2 slice 4) — Agent Skill 接线（YUK-217 spike「结论 B」修正形态）:
// the SDK auto-loads skills from `$CLAUDE_CONFIG_DIR/skills/` (spike 实证：that IS
// the discovery root, NOT additionalDirectories/settingSources). Since the config
// dir is a PROCESS-LEVEL memoised singleton shared by every task, we populate it
// ONCE with ALL subject skills, then let each task's `Options.skills` whitelist
// pick which ones the model sees (context filter). SoT stays at
// src/subjects/<id>/skills/; this just mirrors them into the isolated dir.
let isolatedConfigDir: string | undefined;

// Mirror every src/subjects/<id>/skills/<skill>/ into <isolatedDir>/skills/.
// Best-effort + idempotent: a missing subjects tree (e.g. an unusual cwd) just
// yields no skills, and the runner degrades to promptFragments — never throws.
function populateIsolatedSkills(isolatedDir: string): void {
  // cwd is the repo root for the server (buildQueryOptions sets cwd: process.cwd()).
  const subjectsRoot = join(process.cwd(), 'src', 'subjects');
  if (!existsSync(subjectsRoot)) return;
  const skillsDest = join(isolatedDir, 'skills');
  let subjectIds: string[];
  try {
    subjectIds = readdirSync(subjectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }
  for (const subjectId of subjectIds) {
    const subjectSkillsDir = join(subjectsRoot, subjectId, 'skills');
    if (!existsSync(subjectSkillsDir)) continue;
    let skillNames: string[];
    try {
      skillNames = readdirSync(subjectSkillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const skillName of skillNames) {
      const src = join(subjectSkillsDir, skillName);
      // Flatten into <isolatedDir>/skills/<skillName>/ — skill names are unique
      // across subjects (quiz-gen-<kind> is subject-scoped by directory but the
      // SKILL.md `name` is the global key, so collisions would be a config bug).
      const dest = join(skillsDest, skillName);
      try {
        cpSync(src, dest, { recursive: true });
      } catch (err) {
        console.error('[runner] failed to populate skill into isolated config dir', {
          skill: skillName,
          subject: subjectId,
          err,
        });
      }
    }
  }
}

function getIsolatedClaudeConfigDir(): string {
  if (!isolatedConfigDir) {
    const dir = mkdtempSync(join(tmpdir(), 'loom-claude-'));
    populateIsolatedSkills(dir);
    isolatedConfigDir = dir;
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
    // YUK-225 (S2 slice 4) — Agent Skill whitelist. Only pass the option when a
    // handler set ctx.skills (降级链：omitted → SDK loads nothing extra → current
    // promptFragments behaviour). settingSources stays OMITTED on purpose — the
    // YUK-217 spike proved `[]` disables CONFIG_DIR/skills auto-load (双 NO),
    // so the populated skills only stay visible when settingSources is unset.
    ...(ctx.skills && ctx.skills.length > 0 ? { skills: ctx.skills } : {}),
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
  try {
    await writeAiTaskRunStarted(ctx.db, {
      id: taskRunId,
      task_kind: kind,
      provider: resolved.provider,
      model: resolved.model,
      input_hash: inputHash(actualInput),
      started_at: new Date(),
    });
  } catch (err) {
    console.error('[runTask] writeAiTaskRunStarted failed', { task_run_id: taskRunId, kind, err });
  }

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
  } catch (err) {
    try {
      await writeAiTaskRunFinished(ctx.db, {
        id: taskRunId,
        status: 'failure',
        finish_reason: 'error',
        usage,
        cost_usd,
        error_message: err instanceof Error ? err.message : String(err),
      });
    } catch (finishErr) {
      console.error('[runTask] writeAiTaskRunFinished failure failed', {
        task_run_id: taskRunId,
        kind,
        err: finishErr,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // CostLedger: `cost_ledger.cost` is `real`, stored in USD (consistent
  // with /api/cost/today which sums + renders as $<spend>). Write the
  // raw USD float; do NOT multiply by 1e6.
  try {
    await writeCostLedger(ctx.db, {
      task_run_id: taskRunId,
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

  try {
    await writeAiTaskRunFinished(ctx.db, {
      id: taskRunId,
      status: 'success',
      finish_reason: stopReason,
      usage,
      cost_usd,
    });
  } catch (err) {
    console.error('[runTask] writeAiTaskRunFinished success failed', {
      task_run_id: taskRunId,
      kind,
      err,
    });
  }

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
        try {
          await writeAiTaskRunStarted(ctx.db, {
            id: taskRunId,
            task_kind: kind,
            provider: resolved.provider,
            model: resolved.model,
            input_hash: inputHash(actualInput),
            started_at: new Date(),
          });
        } catch (err) {
          console.error('[streamTask] writeAiTaskRunStarted failed', {
            task_run_id: taskRunId,
            kind,
            err,
          });
        }

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
                  task_run_id: taskRunId,
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
              try {
                await writeAiTaskRunFinished(ctx.db, {
                  id: taskRunId,
                  status: 'success',
                  finish_reason: stopReason,
                  usage,
                  cost_usd,
                });
              } catch (err) {
                console.error('[streamTask] writeAiTaskRunFinished success failed', {
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
        try {
          await writeAiTaskRunFinished(ctx.db, {
            id: taskRunId,
            status: 'failure',
            finish_reason: 'error',
            usage,
            cost_usd,
            error_message: err instanceof Error ? err.message : String(err),
          });
        } catch (finishErr) {
          console.error('[streamTask] writeAiTaskRunFinished failure failed', {
            task_run_id: taskRunId,
            kind,
            err: finishErr,
          });
        }
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
