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
  type OutputFormat,
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
  /**
   * YUK-299 seam: the structured product the SDK fills in when `ctx.outputFormat`
   * is set AND the endpoint supports it. undefined ⇒ outputFormat not set /
   * endpoint unsupported / model fell back to text — the caller must run the
   * text-fallback parse. Pure passthrough; runner never interprets it.
   */
  structured_output?: unknown;
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
   * the model's listing (SDK context filter). When omitted/empty, the runner passes
   * `skills: []` — an EXPLICIT disable — so no quiz-gen skill leaks into tasks that
   * never opt in (降级链 falls back to promptFragments).
   *
   * Why explicit-disable rather than omit: per sdk.d.ts:1699-1721 / 2768-2771,
   * OMITTING `Options.skills` makes the CLI load EVERY discovered skill. Because the
   * runner pre-populates CONFIG_DIR/skills with all subject skills, omitting would
   * expose every quiz-gen skill to Attribution / NoteGenerate / etc. — a zero-impact
   * regression. `[]` keeps the default behaviour identical to pre-slice-4.
   *
   * The SoT lives in src/subjects/<id>/skills/; the runner populates the isolated
   * CLAUDE_CONFIG_DIR/skills once at process start (getIsolatedClaudeConfigDir),
   * and this array keys WHICH of the populated skills the model actually sees. Per
   * the YUK-217 spike, `settingSources` (a SEPARATE field) must stay OMITTED —
   * passing settingSources:[] disables the CONFIG_DIR/skills auto-load.
   */
  skills?: string[];
  /**
   * YUK-299 seam: Agent SDK `outputFormat` passthrough. OMITTED (the default)
   * ⇒ buildQueryOptions does NOT write the key ⇒ the Options object is
   * byte-identical to pre-seam (zero regression). Only a handler migrated to
   * structured output sets it (value produced by zodToJsonSchemaOutputFormat()
   * in ./output-format). streamTask does NOT read it — see §2.3 of the plan;
   * stream + one-shot json_schema output are deferred to a follow-up YUK.
   */
  outputFormat?: OutputFormat;
}

export type RunAgentTaskCtx = RunTaskCtx;
export type StreamTaskCtx = RunTaskCtx & {
  /** Reserved for back-compat with the old Vercel AI SDK shape; ignored. */
  tools?: Record<string, unknown>;
  /**
   * YUK-238 [STB-4]: the request's AbortSignal (`req.signal`). When the client
   * disconnects mid-stream, wiring this into the SDK's abortController tears the
   * in-flight agent run down instead of letting it burn the model budget to
   * completion. Optional so non-HTTP callers (tests, background jobs) can omit
   * it; the ReadableStream `cancel` callback is the second, transport-level
   * trigger that also aborts. Threading a real signal from a route is the
   * follow-up — see YUK-238 note where the route calls streamReviewTask.
   */
  signal?: AbortSignal;
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

// Resolve the on-disk src/subjects root across deploy layouts. In dev/test cwd is the
// repo root, so <cwd>/src/subjects exists. In the Next standalone production image the
// worker (`node worker.cjs`) / app (`node server.js`) run with cwd=/app, and the
// Dockerfile copies the skills subtrees to /app/src/subjects (PR #319 F2) — which the
// first candidate also covers. The extra candidate (__dirname-relative) is a belt-and-
// braces fallback should the process be launched from a non-/app cwd. First existing
// candidate wins; none existing → undefined → no skills (degrade to promptFragments).
function resolveSubjectsRoot(): string | undefined {
  const candidates = [
    join(process.cwd(), 'src', 'subjects'),
    // standalone server.js/worker.cjs live at /app; src/subjects is a sibling.
    join('/app', 'src', 'subjects'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Mirror every src/subjects/<id>/skills/<skill>/ into <isolatedDir>/skills/.
// Best-effort + idempotent: a missing subjects tree (e.g. an unusual cwd) just
// yields no skills, and the runner degrades to promptFragments — never throws.
function populateIsolatedSkills(isolatedDir: string): void {
  const subjectsRoot = resolveSubjectsRoot();
  if (!subjectsRoot) return;
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
  const options: Options = {
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
    // YUK-225 (S2 slice 4) — Agent Skill whitelist.
    //
    // SDK 语义实证（node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts）:
    //   - Options.skills:1699-1721 — "omitted (default): no SDK auto-configuration.
    //     The CLI's own defaults still apply, so this is **not** skills off."
    //   - Query-level skills:2768-2771 — "Omit to load every discovered skill."
    //   - `string[]` — "enable only the listed skills … unlisted skills are hidden
    //     from the model's listing and rejected by the Skill tool" (context filter).
    // 即：OMITTED ⇒ CLI 默认加载「全部已发现 skills」；`[]` ⇒ 一个都不启用（显式禁用）。
    //
    // Since getIsolatedClaudeConfigDir() pre-populates the isolated CONFIG_DIR/skills
    // with ALL subject quiz-gen skills, OMITTING the option would leak every quiz-gen
    // skill into the listing of tasks that never set ctx.skills (Attribution /
    // NoteGenerate / …) — a zero-behaviour-change red-line break. So the DEFAULT must
    // be explicit-disable: pass `skills: ctx.skills ?? []`. Only a handler that
    // explicitly whitelists (ctx.skills = ['quiz-gen-<kind>']) sees those skills.
    //
    // settingSources stays OMITTED on purpose — the YUK-217 spike proved
    // settingSources:[] disables the CONFIG_DIR/skills auto-load (CLEAN-PRESEED 双 NO).
    // That is a SEPARATE field from Options.skills; this change does not touch it (the
    // spike's settingSources=OMITTED conclusion is unchanged).
    skills: ctx.skills ?? [],
  };
  // YUK-299 seam: outputFormat passthrough. Default ctx.outputFormat is undefined
  // ⇒ the key is NOT written ⇒ the Options object is byte-identical to pre-seam
  // for every un-migrated task (general chat / teaching / quiz / judges / all
  // stream callers never set it) — the zero-regression contract (约束①). Only a
  // handler that explicitly threads ctx.outputFormat opts into structured output.
  if (ctx.outputFormat !== undefined) {
    options.outputFormat = ctx.outputFormat;
  }
  return options;
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
  // YUK-299 seam: the SDK fills this on the success result when ctx.outputFormat
  // was set AND the endpoint honoured it; otherwise it stays undefined.
  let structuredOutput: unknown;

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
          // YUK-299: present when outputFormat is set + endpoint supports it;
          // undefined when unsupported / not enabled (msg is already narrowed to
          // SDKResultSuccess here, where structured_output?: unknown lives —
          // sdk.d.ts:3579 — so no cast is needed).
          structuredOutput = msg.structured_output;
        } else {
          // YUK-299: SDK structured-output retries exhausted lands here (its
          // SDKResultError subtype, sdk.d.ts:3540) along with every other
          // non-success subtype. The throw behaviour (+ failure 留痕) is
          // unchanged; we only add a distinguishable warn for monitoring.
          if (msg.subtype === 'error_max_structured_output_retries') {
            console.warn(`[${kind}] structured-output retries exhausted`, {
              task_run_id: taskRunId,
            });
          }
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
    // YUK-299: undefined for every un-migrated caller (transparent passthrough).
    structured_output: structuredOutput,
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

  // YUK-238 [STB-4]: connect the request signal so a client disconnect aborts
  // the SDK run. If the caller threads `req.signal` (see StreamTaskCtx.signal),
  // its abort (already-aborted or future) propagates to the shared
  // abortController that buildQueryOptions hands to the SDK below.
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      abortController.abort();
    } else {
      ctx.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
  }

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
                // YUK-240 [STB-6]: the finish-write failed, so this ai_task_runs
                // row stays at status='running' forever (the run actually
                // succeeded). Emit a scannable structured event so a future
                // sweeper / dashboard can reconcile stuck rows. We deliberately
                // do NOT retry the DB write here — when the DB is the thing
                // failing, retrying the same write just compounds the outage.
                // Observability-only fix; a real reconcile job is the follow-up.
                console.warn('[streamTask] task_run_stuck_in_running', {
                  event: 'task_run_stuck_in_running',
                  task_run_id: taskRunId,
                  kind,
                  intended_status: 'success',
                  err: err instanceof Error ? err.message : String(err),
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
          // YUK-240 [STB-6]: the run already errored AND the failure-status
          // finish-write itself failed, so this ai_task_runs row is now stuck at
          // status='running' with no terminal record. Emit the same scannable
          // structured event the success path uses so a reconcile sweeper can
          // find it. No retry — see the success-path note: retrying a DB write
          // during a DB outage just amplifies it. Observability-only.
          console.warn('[streamTask] task_run_stuck_in_running', {
            event: 'task_run_stuck_in_running',
            task_run_id: taskRunId,
            kind,
            intended_status: 'failure',
            err: finishErr instanceof Error ? finishErr.message : String(finishErr),
          });
        }
        controller.enqueue(new TextEncoder().encode(`\n\n${message}\n`));
      } finally {
        clearTimeout(timer);
        controller.close();
      }
    },
    // YUK-238 [STB-4]: transport-level disconnect hook. When the consumer of the
    // response body cancels the stream (client drops the connection / aborts the
    // fetch), the runtime invokes cancel(); abort the SDK run and clear the
    // budget timer so the agent loop stops instead of running to completion in
    // the background. This is the belt to StreamTaskCtx.signal's suspenders —
    // either trigger aborts the same shared abortController.
    cancel() {
      clearTimeout(timer);
      abortController.abort();
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

// ============================================================================
// streamTaskCollecting — YUK-266 (C1). A collecting variant of streamTask:
// streams text deltas to an `onDelta(chunk)` callback (one call per
// assistant-message text chunk — the same honest per-model-turn granularity
// streamTask uses, since buildQueryOptions does NOT set includePartialMessages),
// then RESOLVES the full RunTaskResult (text + task_run_id + usage + cost). Unlike
// streamTask (which returns a text-only Response and discards the final metadata),
// the Copilot S3a turn-persistence contract needs the full reply text AND the real
// task_run_id to persist the experimental:copilot_reply event — so this entrypoint
// hands both back to the caller while still streaming.
//
// Bookkeeping (writeAiTaskRunStarted / tool-call-log / writeCostLedger /
// writeAiTaskRunFinished) + signal/timer abort wiring mirror streamTask. The loop
// is intentionally self-contained (NOT factored out of streamTask's body): that
// body is tightly coupled to its ReadableStream controller (it enqueues encoded
// bytes mid-loop and writes an error marker to the controller on catch), so sharing
// it would either leak the controller into this Promise path or risk the
// stream-cancel.test.ts guards on streamTask's exact behaviour. Keeping streamTask
// byte-identical is the safer atomic move.
// TODO(YUK-266 consolidation): once a second collecting caller appears, extract a
// shared `runAgentStreaming(kind, input, ctx, onDelta): Promise<RunTaskResult>` that
// streamTask wraps in a ReadableStream and this fn returns directly.
//
// GRACEFUL DEGRADE (red line): if the SDK stream throws AFTER some text was
// collected, this still resolves with the collected text + a `partial: true` flag
// (mirroring streamTask's catch that appends an error marker but still finishes), so
// the caller can persist whatever was produced and a turn is never lost.
export interface StreamCollectResult extends RunTaskResult {
  /** Set when the stream errored mid-flight; `text` is whatever was collected. */
  partial?: boolean;
  /** Present on a partial result — the underlying error message. */
  error?: string;
}

export async function streamTaskCollecting(
  kind: string,
  input: unknown,
  ctx: StreamTaskCtx,
  onDelta: (text: string) => void,
): Promise<StreamCollectResult> {
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

  // YUK-238 [STB-4] parity — thread the request signal so a client disconnect
  // aborts the SDK run, same as streamTask.
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      abortController.abort();
    } else {
      ctx.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
  }

  let usage = { inputTokens: 0, outputTokens: 0 };
  let cost_usd: number | undefined;
  let stopReason = 'unknown';
  let resultText = '';
  // YUK-266 — guard the "no terminal result" hole. The sibling streamTask writes
  // the cost ledger + finished(success) row INSIDE the result-success branch, so it
  // never records success without a terminal msg.type==='result'. This collecting
  // variant writes those after the loop, so if the SDK stream ends WITHOUT a
  // terminal result and without throwing, an incomplete run would otherwise be
  // recorded as success (corrupting the cost ledger + run audit). Track whether a
  // terminal success was actually seen; if not, throw so we fall into the existing
  // graceful-degrade catch that records status:'failure'/finish_reason:'error'.
  let sawTerminalResult = false;

  try {
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
      console.error('[streamTaskCollecting] writeAiTaskRunStarted failed', {
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
          onDelta(text);
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
              console.error('[streamTaskCollecting] writeToolCallLog failed', {
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
          sawTerminalResult = true;
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

    // YUK-266 — the stream ended without a terminal success result (and without
    // throwing). Do NOT record success: throw so the graceful-degrade catch below
    // writes status:'failure'/finish_reason:'error' and resolves partial text. This
    // keeps the cost ledger + run audit honest, matching streamTask's invariant.
    if (!sawTerminalResult) {
      throw new Error(`[${kind}] Agent SDK stream ended without a terminal result message`);
    }

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
      console.error('[streamTaskCollecting] writeCostLedger failed', {
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
      console.error('[streamTaskCollecting] writeAiTaskRunFinished success failed', {
        task_run_id: taskRunId,
        kind,
        err,
      });
      console.warn('[streamTaskCollecting] task_run_stuck_in_running', {
        event: 'task_run_stuck_in_running',
        task_run_id: taskRunId,
        kind,
        intended_status: 'success',
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const result: StreamCollectResult = {
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
        console.error('[streamTaskCollecting] afterRun middleware failed', {
          task_run_id: taskRunId,
          kind,
          err,
        });
      }
    }

    return result;
  } catch (err) {
    // GRACEFUL DEGRADE — the run errored. Record the failure terminal status,
    // then RESOLVE (do not re-throw) with whatever text was collected so the
    // caller can still persist the turn. Mirrors streamTask's catch, which keeps
    // streaming a marker rather than tearing the body down.
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
      console.error('[streamTaskCollecting] writeAiTaskRunFinished failure failed', {
        task_run_id: taskRunId,
        kind,
        err: finishErr,
      });
      console.warn('[streamTaskCollecting] task_run_stuck_in_running', {
        event: 'task_run_stuck_in_running',
        task_run_id: taskRunId,
        kind,
        intended_status: 'failure',
        err: finishErr instanceof Error ? finishErr.message : String(finishErr),
      });
    }
    return {
      task_run_id: taskRunId,
      text: resultText,
      finishReason: 'error',
      usage,
      cost_usd,
      partial: true,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
