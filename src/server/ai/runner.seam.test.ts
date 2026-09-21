// Runner seam tests — pi adapter path (post YUK-1025 P4). The Claude Agent
// SDK subprocess is retired; a fake ExecutionAdapter injected via
// __setPiAdapterForTests captures startup args + replays scripted frames, so the
// durable consume loop keeps identical coverage.
//
// Pure no-DB unit: @/server/ai/log is vi.mock'd and `db` is an untouched stub.
// MUST be enumerated in fastTestInclude (vitest.shared.ts): src/server/ai/**
// has no unit glob, so without the entry the db config's src/**/*.test.ts glob
// would sweep it into the testcontainer partition.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the args the runner hands the adapter + let a test pick which result
// frames the scripted query emits (success-with/without structured_output, or an
// error subtype).
const mockPi = vi.hoisted(() => ({
  capturedArgs: undefined as unknown,
  capturedPrompt: undefined as unknown,
  messages: [] as unknown[],
  queryStarted: vi.fn(),
}));

function fakePiAdapter() {
  return {
    id: 'pi' as const,
    startup: vi.fn(async (args: ExecutionAdapterStartupArgs) => {
      mockPi.capturedArgs = args;
      const prepared: PreparedExecutionQuery = {
        query: (prompt) => {
          mockPi.capturedPrompt = prompt;
          mockPi.queryStarted();
          return (async function* () {
            for (const m of mockPi.messages) yield m as RunnerMessage;
          })();
        },
        close: async () => {},
      };
      return prepared;
    }),
  };
}

function capturedOptions() {
  return (mockPi.capturedArgs as ExecutionAdapterStartupArgs).options;
}

// ai/log writers are the only DB-touching calls inside runTask; stub them so no
// real client is needed and we can assert their call args are unchanged.
const logMock = vi.hoisted(() => ({
  started: vi.fn(async (_db: unknown, _row: unknown) => {}),
  finished: vi.fn(async (_db: unknown, _row: unknown) => {}),
  cost: vi.fn(async (_db: unknown, _row: unknown) => {}),
  tool: vi.fn(async (_db: unknown, _row: unknown) => 'tool-log-id'),
}));

vi.mock('@/server/ai/log', () => ({
  logMissingToolMountsWarning: vi.fn(),
  writeAiTaskRunStarted: logMock.started,
  writeAiTaskRunFinished: logMock.finished,
  writeAiTaskRunRetried: vi.fn(async () => true),
  writeCostLedger: logMock.cost,
  writeAiTaskAttemptFinished: vi.fn(
    async (
      db: unknown,
      row: {
        id: string;
        status: string;
        finish_reason: string;
        usage: unknown;
        cost_truth: { amountUsd: number | null; basis: string; ref: string };
        error_message?: string;
        outcome: string;
      },
    ) => {
      await logMock.finished(db, {
        id: row.id,
        status: row.status,
        finish_reason: row.finish_reason,
        usage: row.usage,
        cost_usd: row.cost_truth.amountUsd ?? undefined,
        cost_basis: row.cost_truth.basis,
        cost_ref: row.cost_truth.ref,
        error_message: row.error_message,
      });
      await logMock.cost(db, {
        task_run_id: row.id,
        cost: row.cost_truth.amountUsd,
        cost_basis: row.cost_truth.basis,
        cost_ref: row.cost_truth.ref,
        outcome: row.outcome,
      });
      return true;
    },
  ),
  writeToolCallLog: logMock.tool,
}));

import { tasks } from '@/ai/registry';
import {
  type ExecutionAdapterStartupArgs,
  type PreparedExecutionQuery,
  type RunnerMessage,
  __setPiAdapterForTests,
} from './execution-adapter';
import { runTask, streamTask, streamTaskCollecting } from './runner';
import type { Options } from './sdk-types';
import { taskInputHash } from './task-input-hash';

// Minimal db stub — never dereferenced because every ai/log writer is mocked.
const fakeDb = {} as never;

describe('native live-session compaction', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    vi.stubEnv('XIAOMI_API_KEY', 'test-key');
  });
  afterEach(() => {
    __setPiAdapterForTests(undefined);
    vi.unstubAllEnvs();
  });
  it('forwards nativeCompaction + caller piHooks while preserving the resume pointer', async () => {
    mockPi.messages = [successResult()];
    const piHooks = { beforeToolCall: [], afterToolCall: [] };
    const context =
      '<turn_context>{"v":1,"learner_state":"当前目标：含参方程；先核对定义域"}</turn_context>';
    await runTask(
      'AttributionTask',
      { q: 1 },
      {
        db: fakeDb,
        sdkSession: { persist: true, resume: 'pi:same-session' },
        piHooks,
        piSessionReplay: [{ role: 'user', text: 'prior turn' }],
        nativeCompaction: { sessionContext: context },
      },
    );
    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    // Compaction re-injection is adapter-side (transformContext); the runner
    // only forwards the descriptor + resolved session replay verbatim.
    expect(args.nativeCompaction).toEqual({ sessionContext: context });
    expect(args.piHooks).toBe(piHooks);
    expect(args.piSessionReplay).toEqual([{ role: 'user', text: 'prior turn' }]);
    expect(args.options.resume).toBe('pi:same-session');
    expect('settings' in args.options).toBe(false);
    expect('hooks' in args.options).toBe(false);
  });

  it('does not configure ordinary non-session tasks', async () => {
    mockPi.messages = [successResult()];
    await runTask('AttributionTask', { q: 1 }, { db: fakeDb });
    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.nativeCompaction).toBeUndefined();
    expect(args.piHooks).toBeUndefined();
    expect(args.piSessionReplay).toBeUndefined();
    expect(args.options.resume).toBeUndefined();
  });

  it('persists only bounded compact metadata without subtracting billable usage or accepting failure', async () => {
    mockPi.messages = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'same-session',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 185065,
          post_tokens: 458,
          compact_summary: 'PRIVATE_SUMMARY',
          preserved_messages: { uuids: ['private-message'] },
        },
      },
      successResult(),
    ];
    await runTask('AttributionTask', { q: 1 }, { db: fakeDb });
    const row = logMock.finished.mock.calls.at(-1)?.[1];
    expect(row).toMatchObject({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        compaction: { count: 1, last: { trigger: 'auto', preTokens: 185065, postTokens: 458 } },
      },
    });
    expect(JSON.stringify(row)).not.toContain('PRIVATE_SUMMARY');
    expect(JSON.stringify(row)).not.toContain('private-message');
    mockPi.messages = [mockPi.messages[0], errorResult('error_during_execution')];
    await expect(runTask('AttributionTask', { q: 1 }, { db: fakeDb })).rejects.toThrow();
    expect(logMock.finished.mock.calls.at(-1)?.[1]).toMatchObject({
      status: 'failure',
      usage: { compaction: { count: 1 } },
    });
  });
});

function successResult(opts: { text?: string; structured_output?: unknown } = {}) {
  const base: Record<string, unknown> = {
    type: 'result',
    subtype: 'success',
    result: opts.text ?? 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  };
  if ('structured_output' in opts) base.structured_output = opts.structured_output;
  return base;
}

function errorResult(subtype: string) {
  return { type: 'result', subtype };
}

function assistantThinking(thinking: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking, signature: '' }] },
  };
}

// AttributionTask is a no-tool task — a representative baseline for the
// zero-regression assertions.
const UNMIGRATED_KIND = 'AttributionTask';

const REVIEW_REGRESSION_PACKET = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      'src/server/grounding-gate/fixtures/intervention-review-regressions.v1.json',
    ),
    'utf8',
  ),
) as {
  cases: Array<{ context: { snapshot: unknown; recommendation: unknown }; package: unknown }>;
};

describe('runTask — YUK-590 retry and cost-reporting lane budgets', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.capturedPrompt = undefined;
    mockPi.messages = [successResult()];
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
    vi.stubEnv('AI_PROVIDER_MODEL', '');
    vi.stubEnv('CLAUDE_CODE_MAX_RETRIES', undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('writes no transport env/retry/budget knobs onto the call spec (adapter owns them)', async () => {
    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    const opts = capturedOptions() as Record<string, unknown>;
    // Post-P4: env blocks, CLI retry ceilings and SDK budget knobs are gone —
    // the pi adapter owns retries via stream options and the durable lifecycle
    // owns cost accounting.
    expect('env' in opts).toBe(false);
    expect('maxBudgetUsd' in opts).toBe(false);
    expect('maxRetries' in opts).toBe(false);
  });

  it('runs the typed provider callback after durable start and before query submission', async () => {
    logMock.started.mockClear();
    mockPi.queryStarted.mockClear();
    const beforeProviderQuery = vi.fn(async () => {
      expect(logMock.started).toHaveBeenCalledTimes(1);
      expect(mockPi.queryStarted).not.toHaveBeenCalled();
    });

    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb, beforeProviderQuery });

    expect(beforeProviderQuery).toHaveBeenCalledWith(
      expect.objectContaining({ taskRunId: expect.any(String) }),
    );
    expect(mockPi.queryStarted).toHaveBeenCalledTimes(1);
  });

  it('runs the streaming provider callback after durable start and before query submission', async () => {
    logMock.started.mockClear();
    mockPi.queryStarted.mockClear();
    const beforeProviderQuery = vi.fn(async () => {
      expect(logMock.started).toHaveBeenCalledTimes(1);
      expect(mockPi.queryStarted).not.toHaveBeenCalled();
    });

    await streamTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb, beforeProviderQuery }).text();

    expect(beforeProviderQuery).toHaveBeenCalledWith(
      expect.objectContaining({ taskRunId: expect.any(String) }),
    );
    expect(mockPi.queryStarted).toHaveBeenCalledTimes(1);
  });

  it('runs the collecting provider callback after durable start and before query submission', async () => {
    logMock.started.mockClear();
    mockPi.queryStarted.mockClear();
    const beforeProviderQuery = vi.fn(async () => {
      expect(logMock.started).toHaveBeenCalledTimes(1);
      expect(mockPi.queryStarted).not.toHaveBeenCalled();
    });

    await streamTaskCollecting(
      UNMIGRATED_KIND,
      { q: 1 },
      { db: fakeDb, beforeProviderQuery },
      vi.fn(),
    );

    expect(beforeProviderQuery).toHaveBeenCalledWith(
      expect.objectContaining({ taskRunId: expect.any(String) }),
    );
    expect(mockPi.queryStarted).toHaveBeenCalledTimes(1);
  });

  it('records returned thinking-block presence without persisting raw reasoning', async () => {
    mockPi.messages = [assistantThinking('private scratch work'), successResult()];

    const result = await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      thinkingBlocks: 1,
      thinkingCharacters: 20,
    });
    const finished = logMock.finished.mock.calls.at(-1)?.[1] as {
      usage: Record<string, unknown>;
    };
    expect(finished.usage).toEqual(result.usage);
    expect(JSON.stringify(finished)).not.toContain('private scratch work');
  });

  it('isolates a production-shaped reviewer packet from project settings and title generation', async () => {
    const regression = REVIEW_REGRESSION_PACKET.cases[0];
    if (!regression) throw new Error('review regression fixture has no cases');
    const input = {
      snapshot: regression.context.snapshot,
      recommendation: regression.context.recommendation,
      package: regression.package,
    };
    expect(JSON.stringify(input).length).toBeGreaterThan(7_000);

    await runTask('InterventionPackageReviewTask', input, { db: fakeDb });

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    // Post-P4 structural invariant: no settingSources / skills / title knobs
    // exist on the call spec at all — repo instructions cannot leak in because
    // the pi lane never reads project config.
    for (const dead of ['settingSources', 'skills', 'title', 'env']) {
      expect(dead in args.options).toBe(false);
    }
    expect(args.piSkillDocs).toBeUndefined();
  });

  it('resolves the anthropic direct provider credential without a budget knob', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-anthropic-test-key');

    await runTask(
      UNMIGRATED_KIND,
      { q: 1 },
      {
        db: fakeDb,
        override: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      },
    );

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.resolved.provider).toBe('anthropic');
    expect(args.resolved.apiKey).toBe('sk-anthropic-test-key');
    expect('maxBudgetUsd' in args.options).toBe(false);
  });
});

describe('runTask — YUK-299 structured_output consume seam', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.messages = [];
    logMock.started.mockClear();
    logMock.finished.mockClear();
    logMock.cost.mockClear();
    logMock.tool.mockClear();
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('keeps the registry one-turn ceiling (the SDK structured-output retry headroom is gone)', async () => {
    mockPi.messages = [successResult()];

    await runTask('InterventionRecommendationTask', { snapshot: 'test' }, { db: fakeDb });

    const opts = capturedOptions() as { maxTurns?: number };
    expect(opts.maxTurns).toBe(1);
  });

  it('passes through structured_output when the success result carries it (state A)', async () => {
    const payload = { verdict: 'pass', confidence: 0.9 };
    mockPi.messages = [successResult({ structured_output: payload })];

    const result = await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    expect(result.structured_output).toEqual(payload);
  });

  it('leaves structured_output undefined when the success result omits it (state C — endpoint fallback)', async () => {
    mockPi.messages = [successResult()];

    const result = await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    expect(result.structured_output).toBeUndefined();
  });

  it('throws + warns on error_max_structured_output_retries (state B)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPi.messages = [errorResult('error_max_structured_output_retries')];

    await expect(runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb })).rejects.toThrow(
      /error_max_structured_output_retries/,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('structured-output retries exhausted'),
      expect.objectContaining({ task_run_id: expect.any(String) }),
    );
  });

  it('does NOT warn on an unrelated error subtype (warn is structured-output specific)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPi.messages = [errorResult('error_max_turns')];

    await expect(runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb })).rejects.toThrow(
      /error_max_turns/,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps the 留痕 write calls unchanged on the structured-output success path (约束②)', async () => {
    mockPi.messages = [successResult({ structured_output: { verdict: 'pass' } })];

    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    // started + finished(success) + cost ledger each called exactly once, and the
    // finished/cost args carry NO new structured_output field (seam does not log it).
    expect(logMock.started).toHaveBeenCalledTimes(1);
    expect(logMock.finished).toHaveBeenCalledTimes(1);
    expect(logMock.cost).toHaveBeenCalledTimes(1);
    const finishedArgs = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect('structured_output' in finishedArgs).toBe(false);
    expect(finishedArgs.status).toBe('success');
    const costArgs = logMock.cost.mock.calls[0][1] as Record<string, unknown>;
    expect('structured_output' in costArgs).toBe(false);
  });
});

// YUK-572 — runner nested-agents/hooks passthrough seam, post-P4 shape:
// ctx.piAgents / ctx.piHooks forward verbatim onto the adapter startup args;
// the SDK Options fields (agents/hooks/canUseTool) no longer exist.
describe('runTask — YUK-572 piAgents/piHooks seam', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.messages = [];
    logMock.started.mockClear();
    logMock.finished.mockClear();
    logMock.cost.mockClear();
    logMock.tool.mockClear();
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT write agents/hooks/canUseTool when omitted (zero regression)', async () => {
    mockPi.messages = [successResult()];

    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.piAgents).toBeUndefined();
    expect(args.piHooks).toBeUndefined();
    expect('agents' in args.options).toBe(false);
    expect('hooks' in args.options).toBe(false);
    expect('canUseTool' in args.options).toBe(false);
  });

  it('threads ctx.piAgents through to the startup args when set', async () => {
    mockPi.messages = [successResult()];
    const piAgents = {
      'evidence-scout': {
        description: 'scout',
        prompt: 'p',
        tools: ['mcp__research_evidence__get_question'],
        maxTurns: 12,
      },
    };

    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb, piAgents });

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.piAgents).toEqual(piAgents);
  });

  it('threads ctx.piHooks through to the startup args when set', async () => {
    mockPi.messages = [successResult()];
    const piHooks = {
      beforeToolCall: [async () => undefined],
      afterToolCall: [async () => undefined],
    };

    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb, piHooks });

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.piHooks).toBe(piHooks);
  });
});

// YUK-923 — runner reasoning-effort seam. Same zero-regression contract as the
// seams above: a TaskDefinition that does NOT declare `reasoningEffort` ⇒ the
// `effort` key is never written onto Options (byte-identical to pre-seam; the
// endpoint default applies — the mimo path must stay untouched); a declaration
// ⇒ threaded 1:1 to the SDK-native effort tier. The control surface is the SDK
// `effort` option, NOT thinking on/off and NOT MAX_THINKING_TOKENS (R2 proved
// the env var does not penetrate the CLI).
describe('runTask — YUK-923 reasoning effort seam', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.messages = [successResult()];
    logMock.started.mockClear();
    logMock.finished.mockClear();
    logMock.cost.mockClear();
    logMock.tool.mockClear();
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT write effort when the task spec declares no reasoningEffort (zero regression)', async () => {
    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    const opts = capturedOptions() as Record<string, unknown>;
    expect('effort' in opts).toBe(false);
  });
});

// YUK-365, post-P4 shape: there is no subprocess env block anymore — the OAuth
// token rides `resolved.apiKey` into the pi driver (sk-ant-oat* → Bearer), and the
// absence of an env map on the call spec IS the selector-clearing fix.
describe('runTask — YUK-365 subscription-OAuth resolution', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.messages = [];
    logMock.started.mockClear();
    logMock.finished.mockClear();
    logMock.cost.mockClear();
    logMock.tool.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('resolves the OAuth token into resolved.apiKey with first-party routing', async () => {
    // Parent env carries conflicting anthropic key/baseUrl vars — under the pi
    // lane they simply cannot leak: the call spec has no env map and auth is
    // the resolved per-request credential.
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'dummy-oauth-token-not-real');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-parent-key-cannot-leak');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://parent.example/cannot-leak');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'parent-auth-cannot-leak');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'anthropic-sub');

    mockPi.messages = [successResult()];
    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.resolved).toMatchObject({
      authMode: 'oauth',
      provider: 'anthropic-sub',
      apiKey: 'dummy-oauth-token-not-real',
      oauthTokenEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    });
    expect('baseUrl' in args.resolved).toBe(false);
    // The lane defaults to Opus 4.8.
    expect(args.options.model).toBe('claude-opus-4-8');
    expect('env' in args.options).toBe(false);
    expect('maxBudgetUsd' in args.options).toBe(false);
  });

  it('cloud-provider selectors in the parent env cannot outrank the OAuth token (Finding 1)', async () => {
    // Claude Code auth precedence let CLAUDE_CODE_USE_* selectors outrank the
    // OAuth token in the subprocess env. Post-P4 there is no subprocess env at
    // all — the pi driver authenticates per-request with resolved.apiKey, so a
    // polluted parent env is structurally inert.
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'dummy-oauth-token-not-real');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
    vi.stubEnv('CLAUDE_CODE_USE_ANTHROPIC_AWS', '1');
    vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '1');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'anthropic-sub');

    mockPi.messages = [successResult()];
    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.resolved).toMatchObject({
      authMode: 'oauth',
      apiKey: 'dummy-oauth-token-not-real',
    });
    expect('env' in args.options).toBe(false);
  });

  it('default (no AI_PROVIDER_OVERRIDE) keeps the mimo key-auth credential; a parent OAuth token cannot bleed in', async () => {
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    // Ensure the override is absent for this case.
    vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
    // Owner placed CLAUDE_CODE_OAUTH_TOKEN in .env.local — on the mimo lane it
    // must not become the credential (lane mutual-exclusion).
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'dummy-oauth-token-not-real');

    mockPi.messages = [successResult()];
    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.resolved).toMatchObject({
      authMode: 'key',
      provider: 'xiaomi',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.xiaomimimo.com/anthropic',
    });
    expect(args.options.model).toBe('mimo-v2.5-pro');
  });
});

// YUK-575 (N5/S2) — the durable copilot run budget override seam. maxIterations →
// SDK maxTurns (buildQueryOptions, shared by runTask + streamTaskCollecting);
// timeoutMs → runTask + streamTaskCollecting timers (sealed validators + durable primary).
// The third durable knob (maxToolCalls) is NOT here — it lives in the handler's
// ContextBudgetTracker (MF-A). undefined-guard: non-durable callers keep def.budget.
describe('runTask / streamTaskCollecting — YUK-575 budgetOverride seam', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.messages = [successResult()];
    logMock.started.mockClear();
    logMock.finished.mockClear();
    logMock.cost.mockClear();
    logMock.tool.mockClear();
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // CopilotTask registry defaults (the durable target task): maxIterations 6,
  // timeout 90_000 (registry.ts DEFAULT_BUDGET + CopilotTask). Byte-identical
  // baselines the override must not touch when omitted.
  const COPILOT = 'CopilotTask';

  it('omitted budgetOverride → maxTurns == registry default (byte-identical)', async () => {
    await runTask(COPILOT, { user_message: 'hi', triggered_by: 'chat' }, { db: fakeDb });
    const opts = capturedOptions() as Record<string, unknown>;
    expect(opts.maxTurns).toBe(6);
    // The seam value is consumed into maxTurns — never leaked as an Options key.
    expect('budgetOverride' in opts).toBe(false);
  });

  it('budgetOverride.maxIterations → Options.maxTurns (durable ceiling)', async () => {
    await runTask(
      COPILOT,
      { user_message: 'hi', triggered_by: 'chat' },
      { db: fakeDb, budgetOverride: { maxIterations: 24 } },
    );
    const opts = capturedOptions() as Record<string, unknown>;
    expect(opts.maxTurns).toBe(24);
    expect('budgetOverride' in opts).toBe(false);
  });

  it('empty budgetOverride object → registry maxTurns (|| 1 fallback preserved)', async () => {
    await runTask(
      COPILOT,
      { user_message: 'hi', triggered_by: 'chat' },
      { db: fakeDb, budgetOverride: {} },
    );
    const opts = capturedOptions() as Record<string, unknown>;
    expect(opts.maxTurns).toBe(6);
  });

  it('runTask: budgetOverride.timeoutMs → abort timer uses the explicit validator tail', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    await runTask(
      COPILOT,
      { user_message: 'hi', triggered_by: 'chat' },
      { db: fakeDb, budgetOverride: { timeoutMs: 240_000 } },
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 240_000);
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 90_000);
  });

  it('streamTaskCollecting: budgetOverride.timeoutMs → abort timer uses the override (~12min, not 90s)', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    await streamTaskCollecting(
      COPILOT,
      { user_message: 'hi', triggered_by: 'chat' },
      { db: fakeDb, budgetOverride: { maxIterations: 24, timeoutMs: 12 * 60_000 } },
      () => {},
    );
    // The durable abort timer is armed with the override, NOT the 90_000 registry
    // default — guards against the timeout override landing in a no-op position.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 12 * 60_000);
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 90_000);
    // maxTurns override still threads through buildQueryOptions on the stream path.
    const opts = capturedOptions() as Record<string, unknown>;
    expect(opts.maxTurns).toBe(24);
  });

  it('streamTaskCollecting: omitted budgetOverride → abort timer uses registry default (90s)', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    await streamTaskCollecting(
      COPILOT,
      { user_message: 'hi', triggered_by: 'chat' },
      { db: fakeDb },
      () => {},
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 90_000);
  });
});

// YUK-589 (K4c) — input_hash is best-effort provenance for the ai_task_runs row;
// it must NEVER fail a task run. `taskInputHash` now THROWS for non-canonicalizable
// inputs (Map/Set/RegExp/function/symbol). Wave-1 replaced the runner's old
// `try/catch → String(input)` fallback with a bare `taskInputHash`, so a throwing
// input started failing the whole run — a regression. This pins that a throwing
// input still completes the run (input_hash degrades to a stable string hash).
describe('runTask — YUK-589 input_hash containment', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.messages = [successResult()];
    logMock.started.mockClear();
    logMock.finished.mockClear();
    logMock.cost.mockClear();
    logMock.tool.mockClear();
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes a run whose input is non-canonicalizable (input_hash falls back, does NOT throw)', async () => {
    // A Map is non-canonicalizable → taskInputHash(input) throws; the runner must
    // contain it, not abort the run.
    const throwingInput = { payload: new Map([['bad', 1]]) };

    const result = await runTask(UNMIGRATED_KIND, throwingInput, { db: fakeDb });

    // The run completed and persisted, and the started row carries a well-formed
    // input_hash produced by the String(input) fallback (never an empty/failed run).
    expect(result.text).toBe('ok');
    expect(logMock.started).toHaveBeenCalledTimes(1);
    const startedRow = logMock.started.mock.calls[0][1] as { input_hash: string };
    expect(startedRow.input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(logMock.finished).toHaveBeenCalledTimes(1);
    const finishedRow = logMock.finished.mock.calls[0][1] as { status: string };
    expect(finishedRow.status).toBe('success');
  });
});

describe('runTask / streamTaskCollecting — caller-owned task run correlation', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.messages = [successResult()];
    logMock.started.mockClear();
    logMock.finished.mockClear();
    logMock.cost.mockClear();
    logMock.tool.mockClear();
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runTask uses the caller id for result and persistence', async () => {
    const result = await runTask(
      'CopilotTask',
      { user_message: 'hi', triggered_by: 'chat' },
      { db: fakeDb, taskRunId: 'copilot_task_owned' },
    );

    expect(result.task_run_id).toBe('copilot_task_owned');
    expect(logMock.started).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ id: 'copilot_task_owned' }),
    );
    expect(logMock.finished).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ id: 'copilot_task_owned' }),
    );
    expect(logMock.cost).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ task_run_id: 'copilot_task_owned' }),
    );
  });

  it('streamTaskCollecting uses the caller id for result and persistence', async () => {
    const result = await streamTaskCollecting(
      'CopilotTask',
      { user_message: 'hi', triggered_by: 'chat' },
      { db: fakeDb, taskRunId: 'copilot_stream_owned' },
      () => {},
    );

    expect(result.task_run_id).toBe('copilot_stream_owned');
    expect(logMock.started).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ id: 'copilot_stream_owned' }),
    );
    expect(logMock.finished).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ id: 'copilot_stream_owned' }),
    );
    expect(logMock.cost).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ task_run_id: 'copilot_stream_owned' }),
    );
  });
});

// YUK-924 — ModelProfile-driven per-model seams (sites 2 + 3) and the P2
// capability gate. The xiaomi-disable and anthropic-only-USD behaviours above
// (YUK-299 / YUK-590 describes) are the pre-existing characterization this
// migration must keep green; the cases here pin the NEW profile-registry
// angles: provider-wide binding coverage of unknown model ids, the zhipu lane,
// runTask-resolution gate rejection, and the model_profile_resolved metadata.
describe('runTask — YUK-924 model-profile seams', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.messages = [successResult()];
    logMock.started.mockClear();
    logMock.finished.mockClear();
    logMock.cost.mockClear();
    logMock.tool.mockClear();
    process.env.XIAOMI_API_KEY = 'sk-test-key';
    process.env.ZHIPU_API_KEY = 'sk-zhipu-test-key';
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic-test-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('REJECTS a needsToolCall task on an unknown-tools model before any adapter call (P2 gate)', async () => {
    await expect(
      runTask(
        'CopilotTask',
        { message: [] },
        { db: fakeDb, override: { provider: 'xiaomi', model: 'mystery-no-tools-model' } },
      ),
    ).rejects.toThrow(
      /CopilotTask requires tool calling.*mystery-no-tools-model.*has no confirmed/s,
    );
    // Fail-closed at resolution: no adapter startup, no durable attempt row.
    expect(mockPi.capturedArgs).toBeUndefined();
    expect(logMock.started).not.toHaveBeenCalled();
  });

  it('REJECTS a multimodal task on a confirmed text-only model (glm-5.2) before any SDK call', async () => {
    await expect(
      runTask(
        'MultimodalDirectJudgeTask',
        { answer_md: 'x' },
        {
          db: fakeDb,
          override: { provider: 'zhipu', model: 'glm-5.2' },
        },
      ),
    ).rejects.toThrow(/requires vision input.*glm-5.2.*does not support/s);
    expect(mockPi.capturedArgs).toBeUndefined();
  });

  it('emits model_profile_resolved run metadata with the effective profile source', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await runTask(
      'AttributionTask',
      { question: 'q', wrong_answer: 'a' },
      { db: fakeDb, override: { provider: 'xiaomi', model: 'mimo-v2.5-pro' } },
    );

    expect(infoSpy).toHaveBeenCalledWith(
      '[runTask] model_profile_resolved',
      expect.objectContaining({
        event: 'model_profile_resolved',
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        // binding layer contributed (vision override + localPricebook)
        profile_source: 'binding',
        reasoning_effort: null,
        profile_effort_default: null,
      }),
    );
    infoSpy.mockRestore();
  });

  it('YUK-936 — sdkSession.persist/resume seam writes the resume pointer for foreground inline only', async () => {
    mockPi.messages = [successResult()];

    await runTask(
      UNMIGRATED_KIND,
      { question: 'q', wrong_answer: 'a' },
      {
        db: fakeDb,
        sdkSession: {
          persist: true,
          resume: 'sdk-resume-id',
          onSessionId: vi.fn(),
        },
      },
    );

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.options.resume).toBe('sdk-resume-id');
    expect('persistSession' in args.options).toBe(false);
  });

  it('uses a caller-compiled provider prompt while auditing the product input separately', async () => {
    const productInput = { user_message: '继续', conversation_history: [{ text: '历史' }] };
    const compiledPromptText = '<turn_context>{"v":1}</turn_context>\n继续';
    const contextDigest = 'a'.repeat(64);
    const compiledModelPrompt = {
      text: compiledPromptText,
      codecVersion: 'copilot-live-turn-v1',
      mode: 'resume' as const,
      contextDigest,
    };
    logMock.started.mockClear();

    await runTask(UNMIGRATED_KIND, productInput, {
      db: fakeDb,
      compiledModelPrompt,
    });

    expect(mockPi.capturedPrompt).toBe(compiledPromptText);
    expect(logMock.started).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        input_hash: taskInputHash(productInput),
        compiledPromptHash: createHash('sha256').update(compiledPromptText).digest('hex'),
        promptCodecVersion: 'copilot-live-turn-v1',
        promptCodecMode: 'resume',
        promptContextDigest: contextDigest,
      }),
    );
    expect(taskInputHash(productInput)).not.toBe(taskInputHash(compiledPromptText));
  });

  it('YUK-936 — omitted sdkSession writes no resume pointer (durable/correction zero regression)', async () => {
    mockPi.messages = [successResult()];

    await runTask(UNMIGRATED_KIND, { question: 'q', wrong_answer: 'a' }, { db: fakeDb });

    const args = mockPi.capturedArgs as ExecutionAdapterStartupArgs;
    expect(args.options.resume).toBeUndefined();
    expect('persistSession' in args.options).toBe(false);
  });

  it('YUK-936 — captures SDK session_id from system init and invokes onSessionId', async () => {
    const onSessionId = vi.fn();
    mockPi.messages = [
      { type: 'system', subtype: 'init', session_id: 'sdk-captured-123' },
      successResult(),
    ];

    await runTask(
      UNMIGRATED_KIND,
      { question: 'q', wrong_answer: 'a' },
      {
        db: fakeDb,
        sdkSession: { persist: true, onSessionId },
      },
    );

    expect(onSessionId).toHaveBeenCalledWith('sdk-captured-123');
  });
});

describe('runTask — YUK-1013 modelBinding (per-run binding seam)', () => {
  beforeEach(() => {
    mockPi.capturedArgs = undefined;
    __setPiAdapterForTests(fakePiAdapter());
    mockPi.capturedPrompt = undefined;
    mockPi.messages = [successResult()];
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
    vi.stubEnv('AI_PROVIDER_MODEL', '');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('routes the binding model through the unchanged explicit layer into SDK options', async () => {
    await runTask(
      UNMIGRATED_KIND,
      { q: 1 },
      {
        db: fakeDb,
        modelBinding: { model: 'mimo-v2.5' },
      },
    );

    const opts = capturedOptions() as { model?: string };
    expect(opts.model).toBe('mimo-v2.5');
  });

  it('lets modelBinding.effort reach SDK options.effort (spec declares none here)', async () => {
    await runTask(
      UNMIGRATED_KIND,
      { q: 1 },
      {
        db: fakeDb,
        modelBinding: { effort: 'high' },
      },
    );

    const opts = capturedOptions() as { effort?: string };
    expect(opts.effort).toBe('high');
  });

  it('lets ctx.override (escape hatch) win per-field over the binding', async () => {
    await runTask(
      UNMIGRATED_KIND,
      { q: 1 },
      {
        db: fakeDb,
        override: { model: 'mimo-v2.5-pro' },
        modelBinding: { model: 'mimo-v2.5' },
      },
    );

    const opts = capturedOptions() as { model?: string };
    expect(opts.model).toBe('mimo-v2.5-pro');
  });

  it('accepts an explicit pi adapter pin on every provider (post-P4 pi is the only engine)', async () => {
    mockPi.queryStarted.mockClear();
    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb, modelBinding: { adapter: 'pi' } });
    expect(mockPi.queryStarted).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a stale non-pi adapter pin before any query (YUK-1025 retirement)', async () => {
    mockPi.queryStarted.mockClear();
    await expect(
      runTask(
        UNMIGRATED_KIND,
        { q: 1 },
        {
          db: fakeDb,
          modelBinding: { adapter: 'sdk' as 'pi' },
        },
      ),
    ).rejects.toThrow(/retired in YUK-1025/);
    expect(mockPi.queryStarted).not.toHaveBeenCalled();
  });
});
