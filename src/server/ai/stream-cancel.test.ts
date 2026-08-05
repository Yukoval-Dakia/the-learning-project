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
  startupGate: undefined as undefined | Promise<void>,
  warmClose: vi.fn(),
  gate: undefined as undefined | Promise<void>,
  terminalMessage: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  startup: vi.fn(async ({ options }: { options: unknown }) => {
    mockSdk.capturedOptions = options;
    if (mockSdk.startupGate) await mockSdk.startupGate;
    return {
      query: vi.fn(() =>
        (async function* () {
          // Emit one assistant delta, then optionally block on `gate` so the test
          // can interact with the still-open stream before it closes.
          yield {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
          };
          if (mockSdk.gate) await mockSdk.gate;
          yield mockSdk.terminalMessage ?? {
            type: 'result',
            subtype: 'success',
            result: 'hi',
            stop_reason: 'end_turn',
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
          };
        })(),
      ),
      close: mockSdk.warmClose,
    };
  }),
  createSdkMcpServer: vi.fn(() => ({ type: 'sdk', name: '', instance: {} })),
  tool: vi.fn((name: string, description: string) => ({ name, description })),
}));

// ai/log writers are the only DB-touching calls inside streamTask; stub them so
// no real client is needed. The `finished` mock can be told to throw to drive
// the YUK-240 stuck-run path.
const logMocks = vi.hoisted(() => ({
  started: vi.fn(async () => {}),
  finishedShouldThrow: false,
  finishedFailuresRemaining: 0,
  terminalStatuses: [] as string[],
  finished: vi.fn(async (_db: unknown, _row: unknown) => {}),
  cost: vi.fn(async (_db: unknown, _row: unknown) => {}),
}));

vi.mock('@/server/ai/log', () => ({
  logMissingMcpServersWarning: vi.fn(),
  writeAiTaskRunStarted: logMocks.started,
  writeAiTaskRunFinished: logMocks.finished,
  writeAiTaskRunRetried: vi.fn(async () => true),
  writeCostLedger: logMocks.cost,
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
      logMocks.terminalStatuses.push(row.status);
      if (logMocks.finishedFailuresRemaining > 0) {
        logMocks.finishedFailuresRemaining -= 1;
        throw new Error('db down once');
      }
      await logMocks.finished(db, {
        id: row.id,
        status: row.status,
        finish_reason: row.finish_reason,
        usage: row.usage,
        cost_usd: row.cost_truth.amountUsd ?? undefined,
        cost_basis: row.cost_truth.basis,
        cost_ref: row.cost_truth.ref,
        error_message: row.error_message,
      });
      if (logMocks.finishedShouldThrow) throw new Error('db down');
      const usage = row.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      await logMocks.cost(db, {
        task_run_id: row.id,
        cost: row.cost_truth.amountUsd,
        cost_basis: row.cost_truth.basis,
        cost_ref: row.cost_truth.ref,
        tokens_in: usage?.inputTokens ?? 0,
        tokens_out: usage?.outputTokens ?? 0,
        outcome: row.outcome,
      });
      return true;
    },
  ),
  writeToolCallLog: vi.fn(async () => 'tool-log-id'),
}));

import { writeAiTaskRunFinished, writeCostLedger } from '@/server/ai/log';
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
    mockSdk.startupGate = undefined;
    mockSdk.warmClose.mockClear();
    mockSdk.gate = undefined;
    mockSdk.terminalMessage = undefined;
    logMocks.finishedShouldThrow = false;
    logMocks.finishedFailuresRemaining = 0;
    logMocks.terminalStatuses = [];
    logMocks.started.mockClear();
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

  it('closes an initialized warm CLI without touching a cancelled stream', async () => {
    let releaseStartup!: () => void;
    mockSdk.startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });

    const response = streamTask('AttributionTask', { q: 'x' }, { db: fakeDb });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('expected a response body');
    await vi.waitFor(() => expect(mockSdk.capturedOptions).toBeDefined());

    await reader.cancel();
    expect(capturedAbortController().signal.aborted).toBe(true);
    releaseStartup();
    await vi.waitFor(() => expect(mockSdk.warmClose).toHaveBeenCalledTimes(1));
    expect(logMocks.terminalStatuses).toEqual([]);
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
    expect(mockSdk.capturedOptions).toBeUndefined();
    expect(logMocks.started).not.toHaveBeenCalled();
    expect(logMocks.terminalStatuses).toEqual([]);
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
    mockSdk.startupGate = undefined;
    mockSdk.warmClose.mockClear();
    mockSdk.gate = undefined;
    mockSdk.terminalMessage = undefined;
    logMocks.finishedShouldThrow = false;
    logMocks.finishedFailuresRemaining = 0;
    logMocks.terminalStatuses = [];
    logMocks.started.mockClear();
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('errors the stream after delivered bytes when the success finish-write fails', async () => {
    logMocks.finishedShouldThrow = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const afterRun = vi.fn(async () => {});
    let release!: () => void;
    mockSdk.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const response = streamTask(
      'AttributionTask',
      { q: 'x' },
      { db: fakeDb, middleware: { afterRun } },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('expected a response body');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('hi');
    release();
    await expect(reader.read()).rejects.toThrow(
      /cannot report success before durable attempt settlement/,
    );

    const stuck = warn.mock.calls.find(
      (call) => (call[1] as { event?: string } | undefined)?.event === 'task_run_stuck_in_running',
    );
    expect(stuck).toBeDefined();
    expect(stuck?.[1]).toMatchObject({
      event: 'task_run_stuck_in_running',
      intended_status: 'failure',
    });
    expect((stuck?.[1] as { task_run_id?: string }).task_run_id).toBeTruthy();
    expect(logMocks.terminalStatuses).toEqual(['success', 'failure']);
    expect(afterRun).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('closes with an error footer when the bounded failure fallback settles', async () => {
    logMocks.finishedFailuresRemaining = 1;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const body = await streamTask('AttributionTask', { q: 'x' }, { db: fakeDb }).text();

    expect(body).toContain('hi');
    expect(body).toContain('cannot report success before durable attempt settlement');
    expect(logMocks.terminalStatuses).toEqual(['success', 'failure']);
    expect(logMocks.finished).toHaveBeenCalledTimes(1);
    expect(logMocks.finished.mock.calls[0][1]).toMatchObject({ status: 'failure' });
    expect(logMocks.cost).toHaveBeenCalledTimes(1);
    expect(logMocks.cost.mock.calls[0][1]).toMatchObject({ outcome: 'failed_permanent' });
    expect(
      warn.mock.calls.some(
        (call) =>
          (call[1] as { event?: string } | undefined)?.event === 'task_run_stuck_in_running',
      ),
    ).toBe(false);

    warn.mockRestore();
  });

  it('errors the stream when failure settlement also fails', async () => {
    logMocks.finishedShouldThrow = true;
    mockSdk.terminalMessage = {
      type: 'result',
      subtype: 'error_max_budget_usd',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: true,
      num_turns: 1,
      session_id: 'session-test',
      total_cost_usd: 0.5,
      usage: { input_tokens: 1, output_tokens: 1 },
      errors: ['budget exhausted'],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = streamTask('AttributionTask', { q: 'x' }, { db: fakeDb });
    await expect(response.text()).rejects.toThrow(/error_max_budget_usd/);

    const stuck = warn.mock.calls.find(
      (call) => (call[1] as { event?: string } | undefined)?.event === 'task_run_stuck_in_running',
    );
    expect(stuck?.[1]).toMatchObject({
      event: 'task_run_stuck_in_running',
      intended_status: 'failure',
    });
    expect(logMocks.terminalStatuses).toEqual(['failure']);

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

describe('streamTask — YUK-590 terminal failure honesty', () => {
  beforeEach(() => {
    mockSdk.capturedOptions = undefined;
    mockSdk.gate = undefined;
    mockSdk.terminalMessage = undefined;
    logMocks.finishedShouldThrow = false;
    logMocks.finishedFailuresRemaining = 0;
    logMocks.terminalStatuses = [];
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('records error_max_budget_usd as failure and exposes the terminal reason', async () => {
    mockSdk.terminalMessage = {
      type: 'result',
      subtype: 'error_max_budget_usd',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: true,
      num_turns: 1,
      session_id: 'session-test',
      total_cost_usd: 0.5,
      usage: { input_tokens: 1, output_tokens: 1 },
      errors: ['budget exhausted'],
    };

    const body = await streamTask('AttributionTask', { q: 'x' }, { db: fakeDb }).text();

    expect(writeAiTaskRunFinished).toHaveBeenCalledTimes(1);
    expect(writeAiTaskRunFinished).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        status: 'failure',
        finish_reason: 'error',
        error_message: expect.stringContaining('error_max_budget_usd'),
      }),
    );
    expect(writeCostLedger).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        outcome: 'failed_permanent',
        cost: 0.5,
        tokens_in: 1,
        tokens_out: 1,
        cost_basis: 'reported',
      }),
    );
    expect(body).toContain('error_max_budget_usd');
  });

  it('records success+is_error as failure instead of charging a successful run', async () => {
    mockSdk.terminalMessage = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      result: 'rate limited',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 0 },
    };

    const body = await streamTask('AttributionTask', { q: 'x' }, { db: fakeDb }).text();

    expect(writeAiTaskRunFinished).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        status: 'failure',
        error_message: expect.stringContaining('api_error_result http=429'),
      }),
    );
    expect(writeCostLedger).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        outcome: 'failed_retryable',
        tokens_in: 1,
        tokens_out: 0,
        cost_basis: 'estimated',
      }),
    );
    expect(body).toContain('api_error_result http=429');
  });
});
