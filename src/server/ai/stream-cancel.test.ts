// YUK-238 [STB-4] + YUK-240 [STB-6] — streamTask client-disconnect abort
// + stuck-run observability. Pure no-DB unit: both the Claude Agent SDK and the
// ai/log writers are vi.mock'd, and `db` is a hand-rolled stub that is never
// touched (the mocked log writers ignore it). So this file imports NO real DB /
// pg / drizzle surface and lives in the fast (unit) partition.
//
// Why a separate file from runner.test.ts: that file drives the real ai/log
// writers against a live Postgres (db partition). These two behaviours don't
// need a DB — they only need to observe (a) the AbortController the runner hands
// to the SDK, and (b) the structured warn emitted when a finish-write throws —
// so they belong in the fast partition where we can run them without a container.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the options the runner passes to the SDK query — chiefly the
// AbortController, which is the wiring point YUK-238 asserts on. `gate` lets a
// test hold the async generator open (stream still streaming) so cancel() /
// signal abort can fire mid-flight.
const mockSdk = vi.hoisted(() => ({
  capturedOptions: undefined as unknown,
  gate: undefined as undefined | Promise<void>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }: { options: unknown }) => {
    mockSdk.capturedOptions = options;
    return (async function* () {
      // Emit one assistant delta, then optionally block on `gate` so the test
      // can interact with the still-open stream before it closes.
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      };
      if (mockSdk.gate) await mockSdk.gate;
      yield {
        type: 'result',
        subtype: 'success',
        result: 'hi',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      };
    })();
  }),
  createSdkMcpServer: vi.fn(() => ({ type: 'sdk', name: '', instance: {} })),
  tool: vi.fn((name: string, description: string) => ({ name, description })),
}));

// ai/log writers are the only DB-touching calls inside streamTask; stub them so
// no real client is needed. The `finished` mock can be told to throw to drive
// the YUK-240 stuck-run path.
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

import { streamTask } from './runner';

// Minimal db stub — never dereferenced because every ai/log writer is mocked.
const fakeDb = {} as never;

async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

function capturedAbortController(): AbortController {
  return (mockSdk.capturedOptions as { abortController: AbortController }).abortController;
}

describe('streamTask — YUK-238 client-disconnect abort', () => {
  beforeEach(() => {
    mockSdk.capturedOptions = undefined;
    mockSdk.gate = undefined;
    logMocks.finishedShouldThrow = false;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('aborts the SDK run when the response body stream is cancelled', async () => {
    // Hold the generator open so the stream is still live when we cancel.
    let release!: () => void;
    mockSdk.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const response = streamTask('AttributionTask', { q: 'x' }, { db: fakeDb });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('expected a response body');

    // Read the first delta so start() has run and handed the abortController to
    // the (mocked) SDK query.
    await reader.read();
    const ac = capturedAbortController();
    expect(ac.signal.aborted).toBe(false);

    // Consumer cancels (client disconnect). cancel() must abort the SDK run.
    await reader.cancel();
    expect(ac.signal.aborted).toBe(true);

    // Let the generator finish so no promise dangles.
    release();
  });

  it('aborts the SDK run when ctx.signal (req.signal) fires mid-stream', async () => {
    let release!: () => void;
    mockSdk.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reqAbort = new AbortController();

    const response = streamTask(
      'AttributionTask',
      { q: 'x' },
      { db: fakeDb, signal: reqAbort.signal },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('expected a response body');
    await reader.read();
    const ac = capturedAbortController();
    expect(ac.signal.aborted).toBe(false);

    // The HTTP request aborts (client went away). The runner's signal wiring
    // propagates that into the SDK abortController.
    reqAbort.abort();
    expect(ac.signal.aborted).toBe(true);

    release();
    await reader.cancel();
  });

  it('aborts immediately when ctx.signal is already aborted before the run starts', async () => {
    const reqAbort = new AbortController();
    reqAbort.abort();

    const response = streamTask(
      'AttributionTask',
      { q: 'x' },
      { db: fakeDb, signal: reqAbort.signal },
    );
    await drain(response);
    expect(capturedAbortController().signal.aborted).toBe(true);
  });

  it('does not abort on a normal full read (no disconnect)', async () => {
    const response = streamTask('AttributionTask', { q: 'x' }, { db: fakeDb });
    await drain(response);
    // start() completes normally; the only abort source is the budget timer,
    // which has not fired. So the run was never aborted by disconnect wiring.
    expect(capturedAbortController().signal.aborted).toBe(false);
  });
});

describe('streamTask — YUK-240 stuck-run observability', () => {
  beforeEach(() => {
    mockSdk.capturedOptions = undefined;
    mockSdk.gate = undefined;
    logMocks.finishedShouldThrow = false;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits task_run_stuck_in_running when the success finish-write fails', async () => {
    logMocks.finishedShouldThrow = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = streamTask('AttributionTask', { q: 'x' }, { db: fakeDb });
    await drain(response);

    const stuck = warn.mock.calls.find(
      (call) => (call[1] as { event?: string } | undefined)?.event === 'task_run_stuck_in_running',
    );
    expect(stuck).toBeDefined();
    expect(stuck?.[1]).toMatchObject({
      event: 'task_run_stuck_in_running',
      intended_status: 'success',
    });
    expect((stuck?.[1] as { task_run_id?: string }).task_run_id).toBeTruthy();

    warn.mockRestore();
  });

  it('does not emit task_run_stuck_in_running on a clean run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = streamTask('AttributionTask', { q: 'x' }, { db: fakeDb });
    await drain(response);

    const stuck = warn.mock.calls.find(
      (call) => (call[1] as { event?: string } | undefined)?.event === 'task_run_stuck_in_running',
    );
    expect(stuck).toBeUndefined();

    warn.mockRestore();
  });
});
