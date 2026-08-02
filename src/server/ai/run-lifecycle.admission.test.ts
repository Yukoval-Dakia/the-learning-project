import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const admissionMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
}));

vi.mock('./provider-session-admission', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider-session-admission')>();
  return {
    ...actual,
    resolveProviderSessionAdmissionPlan: () => ({
      mode: 'enforce' as const,
      laneId: 'xiaomi' as const,
      policy: {
        laneId: 'xiaomi' as const,
        maxConcurrentSessions: 1,
        maxSessionStartsPerMinute: 10,
        maxQueuedSessions: 10,
        maxWaitMs: 1_000,
        fingerprint: 'lifecycle-order-test',
      },
    }),
    acquireProviderSession: admissionMocks.acquire,
  };
});

const logMocks = vi.hoisted(() => ({
  started: vi.fn(async () => {}),
}));

vi.mock('@/server/ai/log', () => ({
  writeAiTaskRunStarted: logMocks.started,
  writeAiTaskAttemptFinished: vi.fn(async () => true),
  writeAiTaskRunRetried: vi.fn(async () => true),
  writeToolCallLog: vi.fn(async () => 'tool-log-id'),
}));

import { ProviderSessionAdmissionError } from './provider-session-admission';
import { createRunLifecycle } from './run-lifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AiRunLifecycle provider-session ordering', () => {
  beforeEach(() => {
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    admissionMocks.acquire.mockReset();
    logMocks.started.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('does not create a cost attempt or arm model timeout while admission waits', async () => {
    const permit = deferred<{
      mode: 'enforce';
      laneId: 'xiaomi';
      borrowedFromTaskRunId: null;
      release(): Promise<void>;
    }>();
    const release = vi.fn(async () => {});
    admissionMocks.acquire.mockReturnValueOnce(permit.promise);
    const timerSpy = vi.spyOn(global, 'setTimeout');
    const callback = vi.fn(async () => 'provider-result');
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'wait-before-attempt',
      timeoutMs: 12_345,
      logScope: 'lifecycle-admission-test',
    });

    const running = lifecycle.withProviderSession({ q: 'x' }, callback);
    await Promise.resolve();
    expect(logMocks.started).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(timerSpy).not.toHaveBeenCalledWith(expect.any(Function), 12_345);

    permit.resolve({
      mode: 'enforce',
      laneId: 'xiaomi',
      borrowedFromTaskRunId: null,
      release,
    });
    await expect(running).resolves.toBe('provider-result');
    expect(logMocks.started).toHaveBeenCalledTimes(1);
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 12_345);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('propagates admission timeout without manufacturing an ai_task_runs row', async () => {
    admissionMocks.acquire.mockRejectedValueOnce(
      new ProviderSessionAdmissionError({
        reason: 'wait_timeout',
        laneId: 'xiaomi',
        taskRunId: 'never-started',
      }),
    );
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'never-started',
      timeoutMs: 1_000,
      logScope: 'lifecycle-admission-test',
    });

    await expect(lifecycle.withProviderSession({ q: 'x' }, async () => 'no')).rejects.toMatchObject(
      {
        reason: 'wait_timeout',
      },
    );
    expect(lifecycle.started).toBe(false);
    expect(logMocks.started).not.toHaveBeenCalled();
  });

  it('does not invoke the provider when durable start crosses the retry deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.now();
    const startWrite = deferred<void>();
    const release = vi.fn(async () => {});
    logMocks.started.mockReturnValueOnce(startWrite.promise);
    admissionMocks.acquire.mockResolvedValueOnce({
      mode: 'enforce',
      laneId: 'xiaomi',
      borrowedFromTaskRunId: null,
      release,
    });
    const callback = vi.fn(async () => 'must-not-run');
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'deadline-during-durable-start',
      timeoutMs: 1_000,
      providerStartDeadlineAt: startedAt + 500,
      logScope: 'lifecycle-admission-test',
    });

    const running = lifecycle.withProviderSession({ q: 'x' }, callback);
    await Promise.resolve();
    expect(logMocks.started).toHaveBeenCalledTimes(1);
    vi.setSystemTime(startedAt + 500);
    startWrite.resolve(undefined);

    await expect(running).rejects.toMatchObject({ reason: 'wait_timeout' });
    expect(lifecycle.started).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
