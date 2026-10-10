// YUK-1356: durable judge forbids lifecycle retry. The transient terminal below
// retains the frozen 2026-07-07 mid-stream-drop probe shape.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPi = vi.hoisted(() => ({
  queryCalls: 0,
  // One message-array per query() invocation (per attempt), consumed in order.
  messageQueues: [] as unknown[][],
}));

import { type RunnerMessage, __setPiAdapterForTests } from './execution-adapter';

function fakePiAdapter() {
  return {
    id: 'pi' as const,
    startup: vi.fn(async () => {
      const messages = mockPi.messageQueues.shift() ?? [];
      return {
        query: vi.fn(() => {
          mockPi.queryCalls += 1;
          return (async function* () {
            for (const m of messages) yield m as RunnerMessage;
          })();
        }),
        close: vi.fn(async () => {}),
      };
    }),
  };
}

const logMock = vi.hoisted(() => ({ retried: vi.fn(async () => true) }));

vi.mock('@/server/ai/log', () => ({
  logMissingToolMountsWarning: vi.fn(),
  writeAiTaskRunStarted: vi.fn(async () => {}),
  writeAiTaskRunFinished: vi.fn(async () => {}),
  writeAiTaskRunRetried: logMock.retried,
  writeCostLedger: vi.fn(async () => {}),
  writeAiTaskAttemptFinished: vi.fn(async () => true),
  writeToolCallLog: vi.fn(async () => 'tool-log-id'),
}));

import { runTask } from './runner';

const fakeDb = {} as never;

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
const JUDGE_KIND = 'StepsJudgeTask';

function resetAll() {
  mockPi.queryCalls = 0;
  mockPi.messageQueues = [];
  logMock.retried.mockClear();
  vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
  __setPiAdapterForTests(fakePiAdapter());
}

describe('runTask — YUK-576 transient retry loop', () => {
  beforeEach(resetAll);
  afterEach(() => {
    __setPiAdapterForTests(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('durable judge policy forbids lifecycle retry even with an opted-in transient task', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPi.messageQueues = [[API_ERROR_CONN_RESULT], [successResult('must not execute')]];
    await expect(
      runTask(
        JUDGE_KIND,
        { q: 1 },
        { db: fakeDb, enableTransientRetry: true, judgeRetryPolicy: 'none' },
      ),
    ).rejects.toThrow();
    expect(mockPi.queryCalls).toBe(1);
    expect(logMock.retried).not.toHaveBeenCalled();
  });
});
