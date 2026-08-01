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
  type OutputFormat,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKTaskNotificationMessage,
  type SDKTaskProgressMessage,
  type SDKTaskStartedMessage,
  type SDKTaskUpdatedMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages';
import type { R2Client } from '../r2';
import { AgentRunError, bindAgentRunError, isApiErrorSuccessResult } from './agent-run-error';
import { logMissingMcpServersWarning } from './log';
import { populateIsolatedSkills } from './populate-skills';
import type { ResolvedProvider } from './providers';
import {
  type AiRunLifecycle,
  type LifecycleUsage,
  classifyLifecycleRetry,
  createRunLifecycle,
  maxLifecycleAttempts,
} from './run-lifecycle';
import { SPAWN_TOOL_NAME } from './spawn-contract';

// ============================================================================
// Public surface
// ============================================================================

export interface RunTaskResult {
  task_run_id: string;
  text: string;
  finishReason: string;
  usage: LifecycleUsage;
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

/**
 * Structural background-task lifecycle messages safe for product observers.
 * Assistant messages (including thinking/text blocks) are intentionally absent.
 */
export type TaskEventMessage =
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKTaskNotificationMessage;

export type TaskEventObserver = (event: TaskEventMessage) => Promise<void> | void;

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
  /**
   * YUK-576 — in-process transient-retry opt-in. Default OFF (undefined):
   * existing callers still make one loom-level attempt. ONLY call paths with NO durable
   * backstop may set this (single-transient-layer principle) — today exactly
   * the two vision judges (steps-judge.ts / multimodal-direct-judge.ts), whose
   * catch swallows failures into 'unsupported' so pg-boss never sees a throw.
   * Durable pg-boss handlers must NOT set it: queue redelivery (queue-config.ts
   * retryLimit) is their single transient layer — stacking both would multiply
   * worst-case paid calls (2×3). Enforced by src/server/ai/retry-optin.test.ts
   * (grep-level pin). Even when set, retry only fires when routing is not
   * pinned (no ctx.override, no AI_PROVIDER_OVERRIDE), the failure is
   * whitelist-transient (agent-run-error.ts §2.3 frozen table), the attempt
   * budget (tasks[kind].budget.transientRetries) has room, and the failure
   * arrived within RETRY_ELAPSED_CAP_MS of the first attempt (sync-route
   * wall-clock bound).
   */
  enableTransientRetry?: boolean;
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
  /**
   * YUK-572 seam: SDK-native nested subagent definitions
   * (Record<string, AgentDefinition>). OMITTED (the default) ⇒ buildQueryOptions does
   * NOT write the key ⇒ the Options object is byte-identical to pre-seam (zero
   * regression). Type is re-exported 1:1 from the SDK's `Options['agents']` so it never
   * drifts from the SDK typings. Only explicit nested-work lanes set it.
   */
  agents?: Options['agents'];
  /** YUK-572 seam: SDK hook callbacks with undefined-guard zero-regression. */
  hooks?: Options['hooks'];
  /** YUK-572 seam: optional SDK permission callback, re-exported 1:1. */
  canUseTool?: Options['canUseTool'];
  /**
   * YUK-757 structural task-lifecycle observer. Only SDK system task_started /
   * task_progress / task_updated / task_notification messages are exposed; raw
   * SDKMessage, assistant text, and thinking blocks never cross this seam.
   * Observer failures are logged and fail open so visibility cannot abort paid work.
   */
  onTaskEvent?: TaskEventObserver;
  /**
   * YUK-575 (N5/MF-A) seam: per-call budget override for the durable copilot run.
   * The inline `CopilotTask` registry budget (maxIterations:6 / timeout:60_000) is
   * the SYNC-request-window budget and MUST stay bounded (< cloudflared idle-100s)
   * for the retained inline fallback. A durable pg-boss run needs a much larger
   * ceiling but MUST NOT mutate the shared registry default (YUK-458 revert lesson:
   * a raised inline budget only turned error_max_turns into an inline-request abort).
   * NARROW: only `maxIterations` (→ SDK maxTurns) and `timeoutMs` (→ the abort timer).
   * The THIRD durable knob — the tool-call ceiling (maxToolCalls) — is NOT here: it
   * lives in the ContextBudgetTracker (budgets.ts, surface-keyed) and is overridden
   * at the handler when constructing the tracker (MF-A). OMITTED (the default) ⇒
   * buildQueryOptions / the stream abort timer read `def.budget` verbatim ⇒
   * byte-identical to pre-seam (zero regression); only the copilot_run handler sets
   * it. It is consumed into maxTurns / the timer and is never an Options key.
   */
  budgetOverride?: { maxIterations?: number; timeoutMs?: number };
  /**
   * Optional caller-owned correlation id shared with an in-process MCP server.
   * Omitted callers keep runner-generated ids. `runTask` uses it for the first
   * attempt; any opt-in transient retry gets a fresh id to preserve row identity.
   */
  taskRunId?: string;
  /**
   * Disable runner-owned tool logging. `runTask` records only the SDK-native Task
   * spawn; MCP DomainTools keep their bridge-owned authoritative input/output row.
   * Streaming runners retain their existing input-only logging contract.
   */
  autoLogToolCalls?: boolean;
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
   * follow-up (YUK-238).
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

function isTaskEventMessage(message: SDKMessage): message is TaskEventMessage {
  if (message.type !== 'system') return false;
  switch (message.subtype) {
    case 'task_started':
    case 'task_progress':
    case 'task_updated':
    case 'task_notification':
      return true;
    default:
      return false;
  }
}

async function notifyTaskEvent(ctx: RunTaskCtx, message: SDKMessage): Promise<void> {
  if (ctx.onTaskEvent === undefined || !isTaskEventMessage(message)) return;
  try {
    await ctx.onTaskEvent(message);
  } catch (error) {
    console.error('[runner] task event observer failed (continuing)', {
      subtype: message.subtype,
      task_id: message.task_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
//
// YUK-225 (S2 slice 4) — Agent Skill 接线（YUK-217 spike「结论 B」修正形态）:
// the SDK auto-loads skills from `$CLAUDE_CONFIG_DIR/skills/` (spike 实证：that IS
// the discovery root, NOT additionalDirectories/settingSources). Since the config
// dir is a PROCESS-LEVEL memoised singleton shared by every task, we populate it
// ONCE with ALL subject skills, then let each task's `Options.skills` whitelist
// pick which ones the model sees (context filter). SoT stays at
// src/subjects/<id>/skills/; this just mirrors them into the isolated dir.
let isolatedConfigDir: string | undefined;

function getIsolatedClaudeConfigDir(): string {
  if (!isolatedConfigDir) {
    const dir = mkdtempSync(join(tmpdir(), 'loom-claude-'));
    populateIsolatedSkills(dir);
    isolatedConfigDir = dir;
  }
  return isolatedConfigDir;
}

// The SDK's `Options.env` REPLACES the subprocess env (it is NOT merged with
// process.env — see sdk.d.ts:1390-1408), so we spread process.env first and then
// layer the auth overrides. The value type is `string | undefined`: setting a key
// to `undefined` is the explicit, self-documenting way to UNSET that var in the
// subprocess (used by the YUK-365 oauth lane to guarantee no parent-process
// ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN wins precedence
// over the subscription token).
function buildAgentEnv(resolved: ResolvedProvider): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') base[k] = v;
  }

  if (resolved.authMode === 'oauth') {
    // YUK-365 subscription lane. The token only works against Anthropic's
    // first-party endpoint and CANNOT coexist with a base URL or an API key
    // (precedence: ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN). Explicitly
    // UNSET the three conflicting vars so a parent-process value can't win, and
    // SET the OAuth token from its env var by NAME (never logged / never copied
    // anywhere else).
    base.CLAUDE_CODE_OAUTH_TOKEN = process.env[resolved.oauthTokenEnv];
    base.ANTHROPIC_BASE_URL = undefined;
    base.ANTHROPIC_API_KEY = undefined;
    base.ANTHROPIC_AUTH_TOKEN = undefined;
    // Codex review P2 (Finding 1): the cloud-provider selectors outrank the
    // OAuth token in Claude Code's auth precedence — if ANY of them is truthy
    // in the parent env, the SDK routes to Bedrock / Vertex / AWS / Foundry and
    // the subscription token is silently ignored. A NAS/docker deployment that
    // sets one of these (or a future dev who exports it) would break the A/B
    // toggle invisibly. Explicitly UNSET all four so the first-party
    // subscription endpoint is the only reachable target on the oauth lane.
    base.CLAUDE_CODE_USE_BEDROCK = undefined;
    base.CLAUDE_CODE_USE_VERTEX = undefined;
    base.CLAUDE_CODE_USE_ANTHROPIC_AWS = undefined;
    base.CLAUDE_CODE_USE_FOUNDRY = undefined;
  } else {
    base.ANTHROPIC_API_KEY = resolved.apiKey;
    if (resolved.baseUrl) {
      base.ANTHROPIC_BASE_URL = resolved.baseUrl;
    } else {
      base.ANTHROPIC_BASE_URL = '';
    }
    // 互斥对称（Codex review P2）：若父进程 env 里有订阅 token（owner 把
    // CLAUDE_CODE_OAUTH_TOKEN 放进 .env.local 后就有），key-auth lane 必须显式
    // UNSET 它——否则 mimo 子进程 env 同时带 API key + OAuth token（违反 lane 互斥，
    // 且会把 token 泄进 mimo lane env / 让 default-lane 测试断言到 token）。
    base.CLAUDE_CODE_OAUTH_TOKEN = undefined;
  }

  base.CLAUDE_CONFIG_DIR = getIsolatedClaudeConfigDir();
  base.CLAUDE_AGENT_SDK_CLIENT_APP = base.CLAUDE_AGENT_SDK_CLIENT_APP ?? 'loom/0.1';
  // YUK-590 — Claude Code 2.1.168 defaults API retries to 10 (11 requests) and
  // honours this integer env override. A persistent 5xx took 177.7s in the frozen
  // probe, well beyond most task budgets and before loom could classify the terminal.
  // Three total CLI attempts keep short transient absorption while returning control
  // to loom's one deliberate retry layer (in-process opt-in OR pg-boss redelivery).
  // Preserve an explicit operator value, including '0'.
  if (base.CLAUDE_CODE_MAX_RETRIES === undefined) {
    base.CLAUDE_CODE_MAX_RETRIES = '2';
  }
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
  // YUK-576 — the caller resolves ONCE per attempt and threads the binding in;
  // previously this function re-ran resolveTaskProvider internally, so every
  // entry point resolved twice (runner.ts:430 + its own top). Single resolution
  // per attempt keeps the retry loop's env/model provably per-attempt-consistent.
  resolved: ResolvedProvider,
): Options {
  const def = tasks[kind];
  const allowedTools = ctx.allowedTools ?? def.allowedTools;
  const configuredSkills = ctx.skills ?? [];
  const configuredMaxTurns = (ctx.budgetOverride?.maxIterations ?? def.budget.maxIterations) || 1;
  // Xiaomi's Anthropic-compatible endpoint does not implement the Agent SDK's
  // native structured-output protocol. Passing outputFormat makes the CLI loop
  // until maxTurns, while every migrated caller already owns a Zod-checked
  // char-scan fallback for the text JSON response.
  const sdkOutputFormat = resolved.provider === 'xiaomi' ? undefined : ctx.outputFormat;
  const options: Options = {
    model: resolved.model,
    systemPrompt: getTaskSystemPrompt(kind, ctx.subjectProfile),
    abortController,
    env: buildAgentEnv(resolved),
    tools: allowedTools,
    mcpServers: ctx.mcpServers,
    // YUK-575 (N5) — durable copilot run overrides the turn ceiling per-call.
    // YUK-792: supported SDK-native outputFormat calls may consume one envelope
    // turn before their terminal result, so floor only that protocol at two.
    // Xiaomi takes the explicit text-JSON fallback above and retains the task's
    // configured ceiling; every higher explicit budget remains unchanged.
    maxTurns: sdkOutputFormat === undefined ? configuredMaxTurns : Math.max(2, configuredMaxTurns),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    cwd: process.cwd(),
    // Ephemeral server runs do not use the persisted session title. Supplying a
    // stable title prevents the CLI from spending a separate model request to
    // synthesize one from the first (often large) product payload.
    title: kind,
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
    // settingSources is handled below: no-skill product runs use SDK isolation;
    // explicitly skill-enabled runs retain the YUK-217 omitted-source discovery path.
    skills: configuredSkills,
  };
  // SDK default/omitted means "load user + project + local settings", including
  // this repository's CLAUDE.md and SessionStart hooks. Those developer-agent
  // instructions are not product context. A no-skill server task therefore uses
  // SDK isolation mode. Skill-enabled tasks keep the key omitted for now because
  // the verified YUK-217 CONFIG_DIR discovery path depends on filesystem settings;
  // the explicit skills whitelist still restricts what the model can invoke.
  if (configuredSkills.length === 0) {
    options.settingSources = [];
  }
  // YUK-299 seam: pass outputFormat only to providers that implement the SDK
  // protocol. Mimo callers intentionally omit the option and consume the
  // existing strict-prompt + Zod text fallback instead.
  if (sdkOutputFormat !== undefined) {
    options.outputFormat = sdkOutputFormat;
  }
  // YUK-572 seam: SDK-native nested-agent / hooks / canUseTool passthrough. Same
  // undefined-guard as the outputFormat seam above — when a caller does not set these
  // (every caller that does not opt into nested work), the keys are NOT written and
  // Options stays byte-identical to pre-seam (零回归). The research-meeting director
  // and Copilot lanes both reuse the same depth-one/report-only contract.
  if (ctx.agents !== undefined) {
    options.agents = ctx.agents;
    // Product UI has one narrative voice. Nested task lifecycle is exposed only via
    // onTaskEvent; forwarding subagent prose would leak a second voice into the parent
    // assistant stream. Pin false instead of relying on an SDK default that may drift.
    options.forwardSubagentText = false;
  }
  if (ctx.hooks !== undefined) {
    options.hooks = ctx.hooks;
  }
  if (ctx.canUseTool !== undefined) {
    options.canUseTool = ctx.canUseTool;
  }
  // YUK-590 — Anthropic direct is the only wired pay-as-you-go lane whose SDK
  // result reports USD. Mimo has no SDK cost signal and anthropic-sub is flat
  // subscription quota, so writing maxBudgetUsd there would be a wired-but-inert lie.
  if (resolved.provider === 'anthropic') {
    options.maxBudgetUsd = def.budget.maxCost;
  }
  return options;
}

// ============================================================================
// runTask — default path. Goes through the Claude Agent SDK like the other
// entry points; tasks without `allowedTools` declared in registry just get
// an empty tool list and behave like a single-turn query.
// ============================================================================

/**
 * YUK-576 — should this call participate in the in-process transient-retry
 * loop? Gate order (design doc §3.2): call-site opt-in (default OFF, so every
 * non-opt-in caller keeps one loom-level attempt) → caller-pinned routing OFF → env-pinned
 * routing OFF (pinned routing is an explicit decision — e.g. induce.ts pins
 * anthropic-sub per call for self-consistency sampling, where a silent retry
 * would still be same-target but the pin marks a lane where wall-clock
 * determinism matters more than absorption).
 */
async function runTaskAttempt(args: {
  kind: TaskKind;
  actualInput: unknown;
  ctx: RunTaskCtx;
  lifecycle: AiRunLifecycle<RunTaskResult>;
}): Promise<RunTaskResult> {
  const { kind, actualInput, ctx, lifecycle } = args;
  await lifecycle.start(actualInput);

  let resultText = '';
  let stepStartTime = Date.now();
  let iteration = 0;
  const thinking = emptyThinkingObservation();
  try {
    const q = sdkQuery({
      prompt: promptFromInput(actualInput),
      options: buildQueryOptions(kind, ctx, lifecycle.abortController, lifecycle.resolved),
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      await notifyTaskEvent(ctx, msg);
      if (msg.type === 'assistant') {
        observeAssistantThinking(msg, thinking);
        iteration += 1;
        const stepLatencyMs = Date.now() - stepStartTime;
        const blocks = (msg.message.content ?? []) as ContentBlock[];
        for (const block of blocks) {
          if (
            block.type === 'tool_use' &&
            block.name === SPAWN_TOOL_NAME &&
            ctx.autoLogToolCalls !== false
          ) {
            await lifecycle.recordToolCall({
              toolName: block.name,
              inputJson: (block.input ?? {}) as Record<string, unknown>,
              iteration,
              latencyMs: stepLatencyMs,
            });
          }
        }
        stepStartTime = Date.now();
        continue;
      }
      if (msg.type !== 'result') continue;
      if (msg.subtype === 'success') {
        if (isApiErrorSuccessResult(msg)) {
          console.warn('[runTask] task_run_success_with_error_flag', {
            event: 'task_run_success_with_error_flag',
            task_run_id: lifecycle.taskRunId,
            kind,
            api_error_status: msg.api_error_status ?? null,
          });
          throw new AgentRunError({
            kind,
            taskRunId: lifecycle.taskRunId,
            subtype: 'api_error_result',
            apiErrorStatus: msg.api_error_status ?? null,
            errors: [msg.result ?? ''],
          });
        }
        const usage = msg.usage;
        resultText = msg.result ?? '';
        lifecycle.recordTerminalSuccess({
          usage: usageWithThinking(
            {
              inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
              outputTokens: usage?.output_tokens ?? 0,
            },
            thinking,
          ),
          tokenCounts: {
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
          },
          costUsd: msg.total_cost_usd,
          finishReason: msg.stop_reason ?? 'stop',
          structuredOutput: msg.structured_output,
        });
      } else {
        if (msg.subtype === 'error_max_structured_output_retries') {
          console.warn(`[${kind}] structured-output retries exhausted`, {
            task_run_id: lifecycle.taskRunId,
          });
        }
        throw new AgentRunError({
          kind,
          taskRunId: lifecycle.taskRunId,
          subtype: msg.subtype,
          errors: 'errors' in msg && Array.isArray(msg.errors) ? msg.errors : [],
        });
      }
      break;
    }

    if (!lifecycle.sawTerminalSuccess) {
      if (lifecycle.aborted) {
        throw new Error(`[${kind}] Agent SDK run aborted (budget timeout) with no terminal result`);
      }
      throw new AgentRunError({
        kind,
        taskRunId: lifecycle.taskRunId,
        subtype: 'stream_no_terminal',
        errors: [],
      });
    }

    const result: RunTaskResult = {
      task_run_id: lifecycle.taskRunId,
      text: resultText,
      finishReason: lifecycle.finishReason,
      usage: lifecycle.usage,
      cost_usd: lifecycle.costUsd,
      structured_output: lifecycle.structuredOutput,
    };
    await lifecycle.finishSuccess(result);
    return result;
  } finally {
    // The outer retry owner disposes after it has classified a thrown error.
  }
}

export async function runTask(
  kind: string,
  input: unknown,
  ctx: RunTaskCtx,
): Promise<RunTaskResult> {
  if (!isKnownTask(kind)) {
    throw new Error(`Unknown task kind: ${kind}`);
  }
  const def = tasks[kind];

  // beforeRun runs exactly once, OUTSIDE the attempt loop — every attempt sees
  // the same transformed input and therefore the same input_hash.
  const actualInput = ctx.middleware?.beforeRun
    ? await ctx.middleware.beforeRun(kind, input, ctx)
    : input;

  const maxAttempts = maxLifecycleAttempts(kind, ctx);
  const firstAttemptStartedAt = Date.now();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const lifecycle = createRunLifecycle<RunTaskResult>({
      db: ctx.db,
      kind,
      timeoutMs: def.budget.timeout,
      override: ctx.override,
      taskRunId: attempt === 1 ? ctx.taskRunId : undefined,
      logScope: 'runTask',
      afterRun: ctx.middleware?.afterRun
        ? (result) => ctx.middleware?.afterRun?.(kind, result, ctx)
        : undefined,
    });
    // Invocation-level guard: keep the warning correlated with the first run
    // row, but never repeat it if this task later gains transient retries.
    if (attempt === 1 && def.needsToolCall && !ctx.mcpServers) {
      logMissingMcpServersWarning({
        task_run_id: lifecycle.taskRunId,
        task_kind: kind,
      });
    }
    try {
      return await runTaskAttempt({ kind, actualInput, ctx, lifecycle });
    } catch (err) {
      const boundError = bindAgentRunError({
        error: err,
        kind,
        taskRunId: lifecycle.taskRunId,
        aborted: lifecycle.aborted,
      });
      lastErr = boundError;
      const retry = classifyLifecycleRetry({
        attempt,
        maxAttempts,
        firstAttemptStartedAt,
        error: boundError,
      });
      await lifecycle.finishFailure(boundError, retry.willRetry ? 'error_retried' : 'error');
      if (!retry.willRetry) throw boundError;
      console.warn('[runTask] task_run_transient_retry', {
        event: 'task_run_transient_retry',
        kind,
        task_run_id: lifecycle.taskRunId,
        attempt,
        elapsed_ms: retry.elapsedMs,
      });
    } finally {
      lifecycle.dispose();
    }
  }
  // Unreachable: the final attempt either returned or threw above. Kept for
  // exhaustiveness (and to satisfy control-flow analysis without a cast).
  throw lastErr;
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
  const lifecycle = createRunLifecycle<RunTaskResult>({
    db: ctx.db,
    kind,
    timeoutMs: def.budget.timeout,
    override: ctx.override,
    taskRunId: ctx.taskRunId,
    signal: ctx.signal,
    logScope: 'streamTask',
    afterRun: ctx.middleware?.afterRun
      ? (result) => ctx.middleware?.afterRun?.(kind, result, ctx)
      : undefined,
  });
  let stepStartTime = Date.now();
  let iteration = 0;
  const thinking = emptyThinkingObservation();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let resultText = '';

      try {
        const actualInput = ctx.middleware?.beforeRun
          ? await ctx.middleware.beforeRun(kind, input, ctx)
          : input;
        await lifecycle.start(actualInput);

        const q = sdkQuery({
          prompt: promptFromInput(actualInput),
          options: buildQueryOptions(kind, ctx, lifecycle.abortController, lifecycle.resolved),
        });
        for await (const msg of q as AsyncIterable<SDKMessage>) {
          await notifyTaskEvent(ctx, msg);
          if (msg.type === 'assistant') {
            observeAssistantThinking(msg, thinking);
            const text = extractAssistantText(msg);
            if (text) {
              controller.enqueue(encoder.encode(text));
              resultText += text;
            }
            iteration += 1;
            const stepLatencyMs = Date.now() - stepStartTime;
            const blocks = (msg.message.content ?? []) as ContentBlock[];
            for (const block of blocks) {
              if (block.type === 'tool_use' && ctx.autoLogToolCalls !== false) {
                await lifecycle.recordToolCall({
                  toolName: block.name,
                  inputJson: (block.input ?? {}) as Record<string, unknown>,
                  iteration,
                  latencyMs: stepLatencyMs,
                });
              }
            }
            stepStartTime = Date.now();
            continue;
          }
          if (msg.type !== 'result') continue;
          if (isApiErrorSuccessResult(msg)) {
            throw new AgentRunError({
              kind,
              taskRunId: lifecycle.taskRunId,
              subtype: 'api_error_result',
              apiErrorStatus: msg.api_error_status ?? null,
              errors: [msg.result ?? ''],
            });
          }
          if (msg.subtype !== 'success') {
            throw new AgentRunError({
              kind,
              taskRunId: lifecycle.taskRunId,
              subtype: msg.subtype,
              errors: 'errors' in msg && Array.isArray(msg.errors) ? msg.errors : [],
            });
          }
          const usage = msg.usage;
          lifecycle.recordTerminalSuccess({
            usage: usageWithThinking(
              {
                inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
                outputTokens: usage?.output_tokens ?? 0,
              },
              thinking,
            ),
            tokenCounts: {
              inputTokens: usage?.input_tokens ?? 0,
              outputTokens: usage?.output_tokens ?? 0,
              cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
              cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
            },
            costUsd: msg.total_cost_usd,
            finishReason: msg.stop_reason ?? 'stop',
          });
          break;
        }

        if (!lifecycle.sawTerminalSuccess) {
          if (lifecycle.aborted) {
            throw new Error(`[${kind}] Agent SDK run aborted with no terminal result`);
          }
          throw new AgentRunError({
            kind,
            taskRunId: lifecycle.taskRunId,
            subtype: 'stream_no_terminal',
            errors: [],
          });
        }

        const result: RunTaskResult = {
          task_run_id: lifecycle.taskRunId,
          text: resultText,
          finishReason: lifecycle.finishReason,
          usage: lifecycle.usage,
          cost_usd: lifecycle.costUsd,
        };
        await lifecycle.finishSuccess(result);
      } catch (error) {
        await lifecycle.finishFailure(error);
        const message =
          error instanceof Error ? `[streamTask] ${error.message}` : '[streamTask] unknown error';
        controller.enqueue(encoder.encode(`\n\n${message}\n`));
      } finally {
        lifecycle.dispose();
        controller.close();
      }
    },
    cancel() {
      lifecycle.abort();
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

interface ThinkingObservation {
  blocks: number;
  characters: number;
}

function emptyThinkingObservation(): ThinkingObservation {
  return { blocks: 0, characters: 0 };
}

/** Count only block presence/size. Raw provider reasoning must never enter logs or artifacts. */
function observeAssistantThinking(
  msg: SDKAssistantMessage,
  observation: ThinkingObservation,
): void {
  const blocks = (msg.message.content ?? []) as ContentBlock[];
  for (const block of blocks) {
    if (block.type !== 'thinking') continue;
    observation.blocks += 1;
    observation.characters += typeof block.thinking === 'string' ? block.thinking.length : 0;
  }
}

function usageWithThinking(
  usage: LifecycleUsage,
  observation: ThinkingObservation,
): LifecycleUsage {
  if (observation.blocks === 0) return usage;
  return {
    ...usage,
    thinkingBlocks: observation.blocks,
    thinkingCharacters: observation.characters,
  };
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
// SDK message adaptation remains local, while run start/provider/abort/tool-log/
// cost/terminal/after-run ownership is shared through run-lifecycle.ts.
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
  const lifecycle = createRunLifecycle<StreamCollectResult>({
    db: ctx.db,
    kind,
    timeoutMs: ctx.budgetOverride?.timeoutMs ?? def.budget.timeout,
    override: ctx.override,
    taskRunId: ctx.taskRunId,
    signal: ctx.signal,
    logScope: 'streamTaskCollecting',
    afterRun: ctx.middleware?.afterRun
      ? (result) => ctx.middleware?.afterRun?.(kind, result, ctx)
      : undefined,
  });
  let stepStartTime = Date.now();
  let iteration = 0;
  let resultText = '';
  const thinking = emptyThinkingObservation();

  try {
    const actualInput = ctx.middleware?.beforeRun
      ? await ctx.middleware.beforeRun(kind, input, ctx)
      : input;
    await lifecycle.start(actualInput);

    const q = sdkQuery({
      prompt: promptFromInput(actualInput),
      options: buildQueryOptions(kind, ctx, lifecycle.abortController, lifecycle.resolved),
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      await notifyTaskEvent(ctx, msg);
      if (msg.type === 'assistant') {
        observeAssistantThinking(msg, thinking);
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
            await lifecycle.recordToolCall({
              toolName: block.name,
              inputJson: (block.input ?? {}) as Record<string, unknown>,
              iteration,
              latencyMs: stepLatencyMs,
            });
          }
        }
        stepStartTime = Date.now();
        continue;
      }
      if (msg.type !== 'result') continue;
      if (msg.subtype === 'success') {
        const usage = msg.usage;
        lifecycle.recordTerminalSuccess({
          usage: usageWithThinking(
            {
              inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
              outputTokens: usage?.output_tokens ?? 0,
            },
            thinking,
          ),
          tokenCounts: {
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
          },
          costUsd: msg.total_cost_usd,
          finishReason: msg.stop_reason ?? 'stop',
        });
        if (isApiErrorSuccessResult(msg)) {
          console.warn('[streamTaskCollecting] task_run_success_with_error_flag', {
            event: 'task_run_success_with_error_flag',
            task_run_id: lifecycle.taskRunId,
            kind,
            api_error_status: msg.api_error_status ?? null,
          });
          throw new AgentRunError({
            kind,
            taskRunId: lifecycle.taskRunId,
            subtype: 'api_error_result',
            apiErrorStatus: msg.api_error_status ?? null,
            errors: msg.result ? [msg.result] : [],
          });
        }
      } else {
        const apiStatus =
          'api_error_status' in msg && msg.api_error_status ? ` http=${msg.api_error_status}` : '';
        throw new Error(`[${kind}] Agent SDK errored: subtype=${msg.subtype}${apiStatus}`);
      }
      break;
    }

    if (!lifecycle.sawTerminalSuccess) {
      throw new Error(`[${kind}] Agent SDK stream ended without a terminal result message`);
    }

    const result: StreamCollectResult = {
      task_run_id: lifecycle.taskRunId,
      text: resultText,
      finishReason: lifecycle.finishReason,
      usage: lifecycle.usage,
      cost_usd: lifecycle.costUsd,
    };
    await lifecycle.finishSuccess(result);
    return result;
  } catch (error) {
    await lifecycle.finishFailure(error);
    return {
      task_run_id: lifecycle.taskRunId,
      text: resultText,
      finishReason: 'error',
      usage: lifecycle.usage,
      cost_usd: lifecycle.costUsd,
      partial: true,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    lifecycle.dispose();
  }
}
