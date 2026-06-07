// YUK-266 (C1) — streamTaskCollecting: a collecting variant of streamTask that
// streams text deltas to an onDelta callback then resolves the full RunTaskResult.
// Pure no-DB unit: @anthropic-ai/claude-agent-sdk and @/server/ai/log are vi.mock'd
// and `db` is an untouched stub, so no live Postgres is needed — mirrors the sibling
// stream-cancel.test.ts (both live in fastTestInclude).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the options the runner hands the SDK (chiefly the AbortController) and
// lets a test feed an arbitrary message sequence + optionally throw mid-stream.
const mockSdk = vi.hoisted(() => ({
  capturedOptions: undefined as unknown,
  messages: [] as unknown[],
  throwAfter: -1 as number, // when >= 0, throw after yielding this many messages
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }: { options: unknown }) => {
    mockSdk.capturedOptions = options;
    return (async function* () {
      let i = 0;
      for (const msg of mockSdk.messages) {
        if (mockSdk.throwAfter >= 0 && i >= mockSdk.throwAfter) {
          throw new Error('sdk blew up mid-stream');
        }
        yield msg;
        i += 1;
      }
    })();
  }),
  createSdkMcpServer: vi.fn(() => ({ type: 'sdk', name: '', instance: {} })),
  tool: vi.fn((name: string, description: string) => ({ name, description })),
}));

const logMocks = vi.hoisted(() => ({
  finishedShouldThrow: false,
}));

vi.mock('@/server/ai/log', () => ({
  writeAiTaskRunStarted: vi.fn(async () => {}),
  writeAiTaskRunFinished: vi.fn(async () => {
    if (logMocks.finishedShouldThrow) throw new Error('db down');
  }),
  writeCostLedger: vi.fn(async () => {}),
  writeToolCallLog: vi.fn(async () => 'tool-log-id'),
}));

import { streamTaskCollecting } from './runner';

const fakeDb = {} as never;

function assistant(text: string) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

const resultMsg = {
  type: 'result',
  subtype: 'success',
  result: 'ignored',
  stop_reason: 'end_turn',
  total_cost_usd: 0,
  usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 },
};

describe('streamTaskCollecting — YUK-266 collecting stream', () => {
  beforeEach(() => {
    mockSdk.capturedOptions = undefined;
    mockSdk.messages = [];
    mockSdk.throwAfter = -1;
    logMocks.finishedShouldThrow = false;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fires onDelta once per assistant-message chunk and resolves the concatenated text', async () => {
    mockSdk.messages = [assistant('Hello, '), assistant('world!'), resultMsg];
    const deltas: string[] = [];

    const result = await streamTaskCollecting('AttributionTask', { q: 'x' }, { db: fakeDb }, (t) =>
      deltas.push(t),
    );

    expect(deltas).toEqual(['Hello, ', 'world!']);
    expect(result.text).toBe('Hello, world!');
    expect(result.finishReason).toBe('end_turn');
    // usage aggregates input + cache_read.
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 7 });
    expect(result.task_run_id).toBeTruthy();
    expect(result.partial).toBeUndefined();
  });

  it('threads the request signal into the SDK abortController (already-aborted)', async () => {
    mockSdk.messages = [assistant('hi'), resultMsg];
    const ac = new AbortController();
    ac.abort();

    await streamTaskCollecting(
      'AttributionTask',
      { q: 'x' },
      { db: fakeDb, signal: ac.signal },
      () => {},
    );

    const captured = (mockSdk.capturedOptions as { abortController: AbortController })
      .abortController;
    expect(captured.signal.aborted).toBe(true);
  });

  it('records failure (not success) when the stream ends without a terminal result message', async () => {
    // Assistant deltas arrive but the SDK stream ends WITHOUT a result message and
    // WITHOUT throwing. The collecting variant must NOT record this as success
    // (which would corrupt the cost ledger + run audit); it falls into the
    // graceful-degrade path: status:'failure' / finishReason:'error' / partial:true.
    mockSdk.messages = [assistant('orphan chunk')];
    const deltas: string[] = [];

    const result = await streamTaskCollecting('AttributionTask', { q: 'x' }, { db: fakeDb }, (t) =>
      deltas.push(t),
    );

    expect(deltas).toEqual(['orphan chunk']);
    expect(result.text).toBe('orphan chunk');
    expect(result.partial).toBe(true);
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('without a terminal result');

    // The finished row must be recorded as a failure — never success.
    const { writeAiTaskRunFinished, writeCostLedger } = await import('@/server/ai/log');
    expect(writeAiTaskRunFinished).toHaveBeenCalledTimes(1);
    expect((writeAiTaskRunFinished as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      status: 'failure',
      finish_reason: 'error',
    });
    // No terminal result ⇒ no cost ledger write (success-only side effect).
    expect(writeCostLedger).not.toHaveBeenCalled();
  });

  it('degrades gracefully: resolves partial text when the SDK throws mid-stream', async () => {
    // Yield one delta, then throw before the result message.
    mockSdk.messages = [assistant('partial chunk'), resultMsg];
    mockSdk.throwAfter = 1;
    const deltas: string[] = [];

    const result = await streamTaskCollecting('AttributionTask', { q: 'x' }, { db: fakeDb }, (t) =>
      deltas.push(t),
    );

    // The collected delta reached the caller, and the resolved result carries it
    // with the partial/error flags — the run did NOT throw.
    expect(deltas).toEqual(['partial chunk']);
    expect(result.text).toBe('partial chunk');
    expect(result.partial).toBe(true);
    expect(result.error).toContain('sdk blew up');
    expect(result.finishReason).toBe('error');
  });
});
