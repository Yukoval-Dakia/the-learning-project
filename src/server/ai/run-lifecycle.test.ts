import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleLogMocks = vi.hoisted(() => ({
  started: vi.fn(async (_db: unknown, _row: unknown) => {}),
  terminal: vi.fn(async (_db: unknown, _row: unknown) => true),
  retried: vi.fn(async (_db: unknown, _id: string) => true),
  tool: vi.fn(async (_db: unknown, _row: unknown) => 'tool-log-id'),
}));

vi.mock('@/server/ai/log', () => ({
  writeAiTaskRunStarted: lifecycleLogMocks.started,
  writeAiTaskAttemptFinished: lifecycleLogMocks.terminal,
  writeAiTaskRunRetried: lifecycleLogMocks.retried,
  writeToolCallLog: lifecycleLogMocks.tool,
}));

import { AgentRunError, RETRY_ELAPSED_CAP_MS } from './agent-run-error';
import {
  AttemptSettlementError,
  classifyLifecycleRetry,
  createRunLifecycle,
  maxLifecycleAttempts,
  transientRetryEnabled,
} from './run-lifecycle';

describe('AI run lifecycle retry policy', () => {
  it('keeps retry disabled unless the caller explicitly opts in without routing pins', () => {
    expect(transientRetryEnabled({})).toBe(false);
    expect(transientRetryEnabled({ enableTransientRetry: true })).toBe(true);
    expect(
      transientRetryEnabled({
        enableTransientRetry: true,
        override: { provider: 'anthropic' },
      }),
    ).toBe(false);
    expect(maxLifecycleAttempts('StepsJudgeTask', {})).toBe(1);
  });

  it('classifies only fast transient non-final attempts for retry', () => {
    const error = new AgentRunError({
      kind: 'StepsJudgeTask',
      taskRunId: 'run_1',
      subtype: 'api_error_result',
      apiErrorStatus: 503,
      errors: [],
    });
    expect(
      classifyLifecycleRetry({
        attempt: 1,
        maxAttempts: 2,
        firstAttemptStartedAt: 1_000,
        now: 1_100,
        error,
      }),
    ).toEqual({ willRetry: true, elapsedMs: 100 });
    expect(
      classifyLifecycleRetry({
        attempt: 1,
        maxAttempts: 2,
        firstAttemptStartedAt: 1_000,
        now: 1_000 + RETRY_ELAPSED_CAP_MS,
        error,
      }).willRetry,
    ).toBe(false);
    expect(
      classifyLifecycleRetry({
        attempt: 2,
        maxAttempts: 2,
        firstAttemptStartedAt: 1_000,
        now: 1_100,
        error,
      }).willRetry,
    ).toBe(false);
  });
});

describe('AI run lifecycle terminal settlement state machine', () => {
  beforeEach(() => {
    lifecycleLogMocks.started.mockReset().mockResolvedValue(undefined);
    lifecycleLogMocks.terminal.mockReset().mockResolvedValue(true);
    lifecycleLogMocks.retried.mockReset().mockResolvedValue(true);
    lifecycleLogMocks.tool.mockReset().mockResolvedValue('tool-log-id');
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function createStartedLifecycle(afterRun = vi.fn(async () => {})) {
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'run-settlement-state',
      timeoutMs: 1_000,
      logScope: 'run-lifecycle-test',
      afterRun,
    });
    return { lifecycle, afterRun };
  }

  function recordSuccess(lifecycle: ReturnType<typeof createStartedLifecycle>['lifecycle']) {
    lifecycle.recordTerminalResult({
      usage: { inputTokens: 7, outputTokens: 3 },
      tokenCounts: { inputTokens: 7, outputTokens: 3 },
      costUsd: 0,
      finishReason: 'end_turn',
    });
    return {
      task_run_id: lifecycle.taskRunId,
      text: 'answer',
      finishReason: lifecycle.finishReason,
      usage: lifecycle.usage,
      cost_usd: lifecycle.costUsd,
      cost_basis: lifecycle.costBasis,
      cost_ref: lifecycle.costRef,
    };
  }

  it('allows one success-to-failure fallback with identical terminal evidence', async () => {
    lifecycleLogMocks.terminal.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { lifecycle, afterRun } = createStartedLifecycle();
    try {
      await lifecycle.start({ q: 'x' });
      const result = recordSuccess(lifecycle);
      let settlementError: unknown;
      try {
        await lifecycle.finishSuccess(result);
      } catch (error) {
        settlementError = error;
      }

      expect(settlementError).toBeInstanceOf(AttemptSettlementError);
      expect(await lifecycle.finishFailure(settlementError)).toBe(true);
      const entries = lifecycleLogMocks.terminal.mock.calls.map((call) => call[1]) as Array<{
        status: string;
        usage: unknown;
        cost_truth: unknown;
      }>;
      expect(entries.map((entry) => entry.status)).toEqual(['success', 'failure']);
      expect(entries[1].usage).toEqual(entries[0].usage);
      expect(entries[1].cost_truth).toEqual(entries[0].cost_truth);
      expect(afterRun).not.toHaveBeenCalled();
    } finally {
      lifecycle.dispose();
    }
  });

  it('never downgrades an already-settled success or writes a second ledger projection', async () => {
    const { lifecycle, afterRun } = createStartedLifecycle();
    try {
      await lifecycle.start({ q: 'x' });
      await lifecycle.finishSuccess(recordSuccess(lifecycle));

      expect(await lifecycle.finishFailure(new Error('late failure'))).toBe(false);
      expect(lifecycleLogMocks.terminal).toHaveBeenCalledTimes(1);
      expect(lifecycleLogMocks.terminal.mock.calls[0][1]).toMatchObject({ status: 'success' });
      expect(afterRun).toHaveBeenCalledTimes(1);
    } finally {
      lifecycle.dispose();
    }
  });
});
