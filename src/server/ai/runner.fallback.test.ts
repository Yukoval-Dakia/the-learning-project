// YUK-576 — runner transient-retry loop + AgentRunError classification.
//
// Pure no-DB unit, same justification as the sibling runner.seam.test.ts:
// @anthropic-ai/claude-agent-sdk and @/server/ai/log are vi.mock'd and `db` is an
// untouched stub, so no live Postgres is needed. MUST be enumerated in
// fastTestInclude (vitest.shared.ts): src/server/ai/** has no unit glob.
//
// ─── FIXTURE PROVENANCE (design doc §2.5, coordinator ack condition 3) ───────
// The terminal-result fixtures below are FROZEN from real forced-failure probes
// run 2026-07-07 against a local HTTP server with a real `sdkQuery` spawn
// (CLI 2.1.168 / @anthropic-ai/claude-agent-sdk 0.3.168, darwin-arm64):
//   - 400 probe   → subtype:'success' + is_error:true + api_error_status:400, instant
//   - 500 probe   → subtype:'success' + is_error:true + api_error_status:500 after
//                   the CLI's INTERNAL api_retry ×10 exponential backoff (177.7s,
//                   11 POSTs) — API errors NEVER surface as SDKResultError
//   - mid-stream-drop probe → subtype:'success' + is_error:true +
//                   api_error_status:null in 1.5s (CLI retried the request once)
//   - connection-refused probe → no terminal within 60s (api_retry attempt 7/10)
// Do NOT "simplify" these shapes: the classification table (design doc §2.3) is
// frozen against them, and the mock must match what the SDK actually emits.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSdk = vi.hoisted(() => ({
  capturedOptions: [] as unknown[],
  // One message-array per query() invocation (per attempt), consumed in order.
  messageQueues: [] as unknown[][],
  // Optional per-attempt hook run before yielding (e.g. advance fake time).
  beforeYield: undefined as undefined | ((attempt: number) => void),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }: { options: unknown }) => {
    mockSdk.capturedOptions.push(options);
    const attempt = mockSdk.capturedOptions.length;
    const messages = mockSdk.messageQueues.shift() ?? [];
    return (async function* () {
      mockSdk.beforeYield?.(attempt);
      for (const m of messages) yield m;
    })();
  }),
  createSdkMcpServer: vi.fn(() => ({ type: 'sdk', name: '', instance: {} })),
  tool: vi.fn((name: string, description: string) => ({ name, description })),
}));

const logMock = vi.hoisted(() => ({
  started: vi.fn(async (_db: unknown, _row: unknown) => {}),
  finished: vi.fn(async (_db: unknown, _row: unknown) => {}),
  cost: vi.fn(async (_db: unknown, _row: unknown) => {}),
  tool: vi.fn(async (_db: unknown, _row: unknown) => 'tool-log-id'),
}));

vi.mock('@/server/ai/log', () => ({
  logMissingMcpServersWarning: vi.fn(),
  writeAiTaskRunStarted: logMock.started,
  writeAiTaskRunFinished: logMock.finished,
  writeCostLedger: logMock.cost,
  writeToolCallLog: logMock.tool,
}));

import { AgentRunError, RETRY_ELAPSED_CAP_MS, isTransientAgentFailure } from './agent-run-error';
import { runTask } from './runner';

const fakeDb = {} as never;

// ─── Frozen probe fixtures (see provenance block above) ──────────────────────

/** 400 probe terminal (instant). subtype success + is_error — NOT SDKResultError. */
const API_ERROR_400_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 400,
  duration_ms: 17,
  duration_api_ms: 0,
  num_turns: 1,
  result: 'API Error: 400 probe: simulated invalid request',
  stop_reason: 'stop_sequence',
  session_id: 'be278263-87d2-4368-a30f-21488dcb899d',
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  },
  modelUsage: {},
  permission_denials: [],
  terminal_reason: 'completed',
  uuid: '0a193ed4-2eb2-47db-9046-17001e3bd870',
} as const;

/** 500 probe terminal (after CLI-internal api_retry ×10 exhaustion, 177.7s). */
const API_ERROR_500_RESULT = {
  ...API_ERROR_400_RESULT,
  api_error_status: 500,
  duration_ms: 176256,
  result:
    'API Error: 500 probe: simulated internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:58551).',
  session_id: '95f160c0-c9c2-4765-b70d-4c5fbf9c8f1d',
  uuid: '63073ea2-cb7a-4200-9677-e786251e1fc0',
} as const;

/** mid-stream-drop probe terminal (1.5s — the canonical fast transient shape). */
const API_ERROR_CONN_RESULT = {
  ...API_ERROR_400_RESULT,
  api_error_status: null,
  duration_ms: 620,
  result:
    'API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
  session_id: '77639a77-aaa3-4c10-8948-5dd6d91e208d',
  uuid: '4c05c3ed-834d-4157-90f5-ac0ee12d1521',
} as const;

function successResult(text = 'ok') {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    stop_reason: 'end_turn',
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  };
}

/** SDKResultError shape (sdk.d.ts:3538-3556) — carries errors[], NO api_error_status. */
function resultError(subtype: string, errors: string[] = []) {
  return { type: 'result', subtype, is_error: true, errors };
}

// AttributionTask: transientRetries inherits DEFAULT (0); StepsJudgeTask: 1.
const NO_RETRY_KIND = 'AttributionTask';
const JUDGE_KIND = 'StepsJudgeTask';

function resetAll() {
  mockSdk.capturedOptions = [];
  mockSdk.messageQueues = [];
  mockSdk.beforeYield = undefined;
  logMock.started.mockClear();
  logMock.finished.mockClear();
  logMock.cost.mockClear();
  logMock.tool.mockClear();
  process.env.XIAOMI_API_KEY = 'sk-test-key';
}

// ─── §10 step 1 — classifier (table-driven over frozen shapes) ───────────────

describe('isTransientAgentFailure — frozen classification table (design doc §2.3)', () => {
  const mk = (over: Partial<AgentRunError> & { subtype: AgentRunError['subtype'] }) =>
    new AgentRunError({
      kind: 'StepsJudgeTask',
      taskRunId: 'run_x',
      errors: [],
      ...over,
    });

  it.each([
    // api_error_result family (probe-frozen: the ONLY shape API errors take)
    {
      name: 'api_error_result + null (connection-class, mid-drop probe)',
      err: mk({ subtype: 'api_error_result', apiErrorStatus: null }),
      transient: true,
    },
    {
      name: 'api_error_result + 429',
      err: mk({ subtype: 'api_error_result', apiErrorStatus: 429 }),
      transient: true,
    },
    {
      name: 'api_error_result + 500 (500 probe)',
      err: mk({ subtype: 'api_error_result', apiErrorStatus: 500 }),
      transient: true,
    },
    {
      name: 'api_error_result + 503',
      err: mk({ subtype: 'api_error_result', apiErrorStatus: 503 }),
      transient: true,
    },
    {
      name: 'api_error_result + 400 (400 probe)',
      err: mk({ subtype: 'api_error_result', apiErrorStatus: 400 }),
      transient: false,
    },
    {
      name: 'api_error_result + 401',
      err: mk({ subtype: 'api_error_result', apiErrorStatus: 401 }),
      transient: false,
    },
    {
      name: 'api_error_result + 404',
      err: mk({ subtype: 'api_error_result', apiErrorStatus: 404 }),
      transient: false,
    },
    // stream/process level
    { name: 'stream_no_terminal', err: mk({ subtype: 'stream_no_terminal' }), transient: true },
    // SDKResultError subtypes — v3.1 flip: error_during_execution is permanent
    // (probes proved API failures NEVER land here).
    {
      name: 'error_during_execution',
      err: mk({ subtype: 'error_during_execution', errors: ['some internal error'] }),
      transient: false,
    },
    { name: 'error_max_turns', err: mk({ subtype: 'error_max_turns' }), transient: false },
    {
      name: 'error_max_budget_usd',
      err: mk({ subtype: 'error_max_budget_usd' }),
      transient: false,
    },
    {
      name: 'error_max_structured_output_retries',
      err: mk({ subtype: 'error_max_structured_output_retries' }),
      transient: false,
    },
  ])('$name → transient=$transient', ({ err, transient }) => {
    expect(isTransientAgentFailure(err)).toBe(transient);
  });

  it('non-AgentRunError values are permanent (abort/timeout, unknown errors)', () => {
    expect(isTransientAgentFailure(new Error('Claude Code process aborted by user'))).toBe(false);
    expect(isTransientAgentFailure(new Error('anything else'))).toBe(false);
    expect(isTransientAgentFailure(undefined)).toBe(false);
  });

  it('AgentRunError message keeps the legacy grep-able format + carries taskRunId/errors', () => {
    const err = new AgentRunError({
      kind: 'StepsJudgeTask',
      taskRunId: 'run_1',
      subtype: 'api_error_result',
      apiErrorStatus: 500,
      errors: [API_ERROR_500_RESULT.result],
    });
    expect(err.message).toMatch(/\[StepsJudgeTask\] Agent SDK errored: subtype=api_error_result/);
    expect(err.message).toMatch(/http=500/);
    expect(err.taskRunId).toBe('run_1');
    expect(err.errors[0]).toContain('API Error: 500');
  });
});

// ─── §10 step 2 — retry loop behavior ────────────────────────────────────────

describe('runTask — YUK-576 transient retry loop', () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('success path: zero retries, one query call, byte-identical bookkeeping', async () => {
    mockSdk.messageQueues = [[successResult()]];

    const result = await runTask(NO_RETRY_KIND, { q: 1 }, { db: fakeDb });

    expect(result.text).toBe('ok');
    expect(mockSdk.capturedOptions).toHaveLength(1);
    expect(logMock.started).toHaveBeenCalledTimes(1);
    expect(logMock.finished).toHaveBeenCalledTimes(1);
    expect(logMock.cost).toHaveBeenCalledTimes(1);
  });

  // ── YUK-590: every success+is_error terminal is an honest failed attempt ───
  it('non-opt-in + success+is_error: throws without retry and records failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSdk.messageQueues = [[API_ERROR_500_RESULT]];

    await expect(runTask(NO_RETRY_KIND, { q: 1 }, { db: fakeDb })).rejects.toThrow(
      /subtype=api_error_result http=500/,
    );

    expect(mockSdk.capturedOptions).toHaveLength(1); // zero retries
    const finished = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finished.status).toBe('failure');
    expect(finished.finish_reason).toBe('error');
    expect(finished.error_message).toContain('API Error: 500');
    expect(logMock.cost).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('task_run_success_with_error_flag'),
      expect.objectContaining({ api_error_status: 500 }),
    );
  });

  it('opt-in + connection-class api error (mid-drop fixture) → retries once, second attempt succeeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSdk.messageQueues = [[API_ERROR_CONN_RESULT], [successResult('recovered')]];

    const result = await runTask(JUDGE_KIND, { q: 1 }, { db: fakeDb, enableTransientRetry: true });

    expect(result.text).toBe('recovered');
    expect(mockSdk.capturedOptions).toHaveLength(2);
    // Two run rows started, same input_hash (same actualInput, hashed once per attempt).
    expect(logMock.started).toHaveBeenCalledTimes(2);
    const hash1 = (logMock.started.mock.calls[0][1] as { input_hash: string }).input_hash;
    const hash2 = (logMock.started.mock.calls[1][1] as { input_hash: string }).input_hash;
    expect(hash1).toBe(hash2);
    // Attempt 1 finished failure with the distinguishable retry marker (§3.3).
    const finish1 = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finish1.status).toBe('failure');
    expect(finish1.finish_reason).toBe('error_retried');
    // Attempt 2 finished success; exactly one ledger row (success attempts only).
    const finish2 = logMock.finished.mock.calls[1][1] as Record<string, unknown>;
    expect(finish2.status).toBe('success');
    expect(logMock.cost).toHaveBeenCalledTimes(1);
    // R3 breadcrumb fired.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('task_run_transient_retry'),
      expect.objectContaining({ kind: JUDGE_KIND }),
    );
    // Same-target retry: attempt-2 env/model identical to attempt-1 (value-level).
    const [o1, o2] = mockSdk.capturedOptions as Array<{
      model: string;
      env: Record<string, string | undefined>;
    }>;
    expect(o2.model).toBe(o1.model);
    expect(o2.env.ANTHROPIC_BASE_URL).toBe(o1.env.ANTHROPIC_BASE_URL);
    expect(o2.env.ANTHROPIC_API_KEY).toBe(o1.env.ANTHROPIC_API_KEY);
  });

  it('opt-in + permanent api error (400 fixture) → throws immediately, no retry, finish_reason=error', async () => {
    mockSdk.messageQueues = [[API_ERROR_400_RESULT]];

    await expect(
      runTask(JUDGE_KIND, { q: 1 }, { db: fakeDb, enableTransientRetry: true }),
    ).rejects.toThrow(/subtype=api_error_result http=400/);

    expect(mockSdk.capturedOptions).toHaveLength(1);
    const finish = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finish.status).toBe('failure');
    expect(finish.finish_reason).toBe('error');
    expect(finish.error_message).toContain('API Error: 400');
  });

  // R2 — non-final PERMANENT failure must NOT be mislabeled error_retried.
  it('opt-in + error_max_structured_output_retries on attempt 1 → no retry + finish_reason=error (never error_retried)', async () => {
    mockSdk.messageQueues = [[resultError('error_max_structured_output_retries')]];

    await expect(
      runTask(JUDGE_KIND, { q: 1 }, { db: fakeDb, enableTransientRetry: true }),
    ).rejects.toThrow(/error_max_structured_output_retries/);

    expect(mockSdk.capturedOptions).toHaveLength(1);
    const finish = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finish.finish_reason).toBe('error');
  });

  // R1 — slow transient (arrives past RETRY_ELAPSED_CAP_MS) must not retry.
  it('opt-in + SLOW transient failure (elapsed ≥ cap) → no retry, throws (R1 sixth gate)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mockSdk.beforeYield = (attempt) => {
      if (attempt === 1) {
        vi.setSystemTime(Date.now() + RETRY_ELAPSED_CAP_MS + 1_000);
      }
    };
    mockSdk.messageQueues = [[API_ERROR_CONN_RESULT], [successResult('never-reached')]];

    await expect(
      runTask(JUDGE_KIND, { q: 1 }, { db: fakeDb, enableTransientRetry: true }),
    ).rejects.toThrow(/api_error_result/);

    expect(mockSdk.capturedOptions).toHaveLength(1);
    const finish = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finish.finish_reason).toBe('error'); // not error_retried (§3.3 truth table)
  });

  it('opt-in + chain exhausted (both attempts transient-fail) → throws last error; rows error_retried then error', async () => {
    mockSdk.messageQueues = [[API_ERROR_CONN_RESULT], [API_ERROR_CONN_RESULT]];

    await expect(
      runTask(JUDGE_KIND, { q: 1 }, { db: fakeDb, enableTransientRetry: true }),
    ).rejects.toThrow(/api_error_result/);

    expect(mockSdk.capturedOptions).toHaveLength(2);
    const finish1 = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    const finish2 = logMock.finished.mock.calls[1][1] as Record<string, unknown>;
    expect(finish1.finish_reason).toBe('error_retried');
    expect(finish2.finish_reason).toBe('error');
    expect(logMock.cost).not.toHaveBeenCalled(); // no success attempt → no ledger rows
  });

  it('transient failure WITHOUT opt-in → no retry (ctx gate, mustFix#6)', async () => {
    // NO_RETRY_KIND has transientRetries 0 anyway; use JUDGE_KIND minus opt-in to
    // isolate the ctx gate specifically.
    mockSdk.messageQueues = [[API_ERROR_CONN_RESULT]];

    await expect(runTask(JUDGE_KIND, { q: 1 }, { db: fakeDb })).rejects.toThrow(
      /socket connection was closed/,
    );

    expect(mockSdk.capturedOptions).toHaveLength(1);
    const finish = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finish.status).toBe('failure');
    expect(finish.finish_reason).toBe('error');
  });

  it('opt-in but caller-pinned override → no retry (YUK-573 load-bearing regression)', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'dummy-oauth-token-not-real');
    mockSdk.messageQueues = [[API_ERROR_CONN_RESULT]];

    await expect(
      runTask(
        JUDGE_KIND,
        { q: 1 },
        {
          db: fakeDb,
          enableTransientRetry: true,
          override: { provider: 'anthropic-sub' },
        },
      ),
    ).rejects.toThrow(/socket connection was closed/);

    expect(mockSdk.capturedOptions).toHaveLength(1);
    const finish = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finish.finish_reason).toBe('error');
  });

  it('opt-in but global AI_PROVIDER_OVERRIDE set → no retry (env gate)', async () => {
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'anthropic-sub');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'dummy-oauth-token-not-real');
    mockSdk.messageQueues = [[API_ERROR_CONN_RESULT]];

    await expect(
      runTask(JUDGE_KIND, { q: 1 }, { db: fakeDb, enableTransientRetry: true }),
    ).rejects.toThrow(/socket connection was closed/);

    expect(mockSdk.capturedOptions).toHaveLength(1);
    const finish = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finish.finish_reason).toBe('error');
  });

  it('beforeRun runs exactly once (input transformed once, both attempts use it)', async () => {
    const beforeRun = vi.fn(async (_kind: string, input: unknown) => ({
      wrapped: input,
    }));
    const afterRun = vi.fn(async () => {});
    mockSdk.messageQueues = [[API_ERROR_CONN_RESULT], [successResult('done')]];

    const result = await runTask(
      JUDGE_KIND,
      { q: 1 },
      { db: fakeDb, enableTransientRetry: true, middleware: { beforeRun, afterRun } },
    );

    expect(result.text).toBe('done');
    expect(beforeRun).toHaveBeenCalledTimes(1);
    expect(afterRun).toHaveBeenCalledTimes(1);
  });
});

// ─── coordinator ack condition 2: GLOBAL stream_no_terminal guard ────────────
// This is the earlier global honesty guard from YUK-576: a stream that ends
// WITHOUT a terminal result message was
// previously recorded as a silent success (empty text, stopReason 'unknown',
// cost ledger written) — a lie in the observability plane. It now throws
// AgentRunError('stream_no_terminal') and records a failure row, for EVERY
// caller (not just opt-in). Durable paths get queue redelivery; judge paths fall
// to 'unsupported' (same as today's parse-fail).

describe('runTask — GLOBAL stream_no_terminal guard (YUK-576, deliberate behavior change)', () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('non-opt-in: stream ending without a terminal result throws + records failure (was: silent success)', async () => {
    mockSdk.messageQueues = [[]]; // stream yields nothing and ends

    await expect(runTask(NO_RETRY_KIND, { q: 1 }, { db: fakeDb })).rejects.toThrow(
      /stream_no_terminal/,
    );

    const finish = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finish.status).toBe('failure');
    expect(logMock.cost).not.toHaveBeenCalled(); // no ledger row for a non-run
  });

  it('opt-in: stream_no_terminal is transient → retried once', async () => {
    mockSdk.messageQueues = [[], [successResult('second-try')]];

    const result = await runTask(JUDGE_KIND, { q: 1 }, { db: fakeDb, enableTransientRetry: true });

    expect(result.text).toBe('second-try');
    expect(mockSdk.capturedOptions).toHaveLength(2);
    const finish1 = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finish1.finish_reason).toBe('error_retried');
  });

  // Review P2-#1 hardening: an abort (budget timeout) can surface as a
  // gracefully-ENDED stream rather than a throw. That must classify as the
  // abort it is (permanent) — never as transient 'stream_no_terminal'. Today
  // the elapsed gate (10s) < min budget.timeout (30s) masks the difference for
  // every registry task, but the classifier must not lean on that invariant.
  it('abort-during-empty-stream classifies as abort (permanent), NOT stream_no_terminal', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    mockSdk.beforeYield = () => {
      // Fire the budget-timeout abort while the stream is still open, then let
      // the generator end with no messages (graceful end, aborted signal set).
      vi.advanceTimersByTime(91_000); // > StepsJudgeTask budget.timeout (90s)
    };
    mockSdk.messageQueues = [[], [successResult('never-reached')]];

    await expect(
      runTask(JUDGE_KIND, { q: 1 }, { db: fakeDb, enableTransientRetry: true }),
    ).rejects.toThrow(/aborted/);

    expect(mockSdk.capturedOptions).toHaveLength(1); // permanent → no retry
    const finish = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect(finish.finish_reason).toBe('error'); // not error_retried
    vi.useRealTimers();
  });
});
