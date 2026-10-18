import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPi = vi.hoisted(() => ({
  release: null as (() => void) | null,
}));

import { type RunnerMessage, __setPiAdapterForTests } from './execution-adapter';

function fakePiAdapter() {
  return {
    id: 'pi' as const,
    startup: vi.fn(async () => ({
      query: vi.fn(() => {
        return (async function* () {
          yield {
            type: 'text_delta',
            text: '圆锥曲线的定义已经写到这里',
          } as RunnerMessage;
          await new Promise<void>((resolve) => {
            mockPi.release = resolve;
          });
        })();
      }),
      close: vi.fn(async () => {}),
    })),
  };
}

vi.mock('@/server/ai/log', () => ({
  logMissingToolMountsWarning: vi.fn(),
  writeAiTaskRunStarted: vi.fn(async () => {}),
  writeAiTaskRunFinished: vi.fn(async () => {}),
  writeAiTaskRunRetried: vi.fn(async () => true),
  writeCostLedger: vi.fn(async () => {}),
  writeAiTaskAttemptFinished: vi.fn(async () => true),
  writeToolCallLog: vi.fn(async () => 'tool-log-id'),
}));

import { writeAiTaskAttemptFinished } from './log';
import { runTask } from './runner';

const fakeDb = {} as never;

describe('runTask note generation timeout usage', () => {
  beforeEach(() => {
    mockPi.release = null;
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    __setPiAdapterForTests(fakePiAdapter());
  });

  afterEach(() => {
    mockPi.release?.();
    __setPiAdapterForTests(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // @invariant data: a timed-out note generation persists the tokens it consumed and a non-zero estimated cost
  // @fails-if the budget abort settles usage {0,0} or cost_usd 0 after streamed text and no provider usage payload
  it('records estimated usage and model phase timings when the provider sends no final usage', async () => {
    const pending = runTask(
      'NoteGenerateTask',
      { artifact_type: 'note_long', title: '圆锥曲线' },
      { db: fakeDb, budgetOverride: { timeoutMs: 30 } },
    );
    const releaseDeadline = Date.now() + 1_000;
    while (!mockPi.release && Date.now() < releaseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    mockPi.release?.();
    await expect(pending).rejects.toThrow(/budget timeout/);

    const entry = vi.mocked(writeAiTaskAttemptFinished).mock.calls[0]?.[1];
    if (!entry) throw new Error('timed-out attempt was not settled');
    expect(entry.usage.inputTokens + entry.usage.outputTokens).toBeGreaterThan(0);
    expect(entry.usage.usage_basis).toBe('estimated');
    expect(entry.usage.outputTokens).toBeGreaterThan(0);
    expect(entry.cost_truth.basis).toBe('estimated');
    expect(entry.cost_truth.amountUsd).toBeGreaterThan(0);
    expect(entry.usage.phases?.model_total_ms).toEqual(expect.any(Number));
    expect(entry.usage.phases?.model_ttft_ms).toEqual(expect.any(Number));
    expect(entry.usage.phases?.prompt_build_ms).toEqual(expect.any(Number));
    expect(entry.usage.phases?.stream_ms).toEqual(expect.any(Number));
  });
});
