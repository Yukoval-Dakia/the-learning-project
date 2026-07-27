import { describe, expect, it } from 'vitest';
import { AgentRunError, RETRY_ELAPSED_CAP_MS } from './agent-run-error';
import {
  classifyLifecycleRetry,
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
