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
      assertProviderStartAllowed(): void;
      completeStartup(): Promise<void>;
      release(): Promise<void>;
    }>();
    const release = vi.fn(async () => {});
    const assertProviderStartAllowed = vi.fn();
    const sequence: string[] = [];
    const completeStartup = vi.fn(async () => {
      sequence.push('complete-startup');
    });
    admissionMocks.acquire.mockReturnValueOnce(permit.promise);
    const timerSpy = vi.spyOn(global, 'setTimeout');
    const startup = deferred<void>();
    const prepare = vi.fn(async () => {
      await startup.promise;
      sequence.push('prepare');
    });
    const run = vi.fn(async () => {
      sequence.push('run');
      return 'provider-result';
    });
    const close = vi.fn(async () => {});
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'wait-before-attempt',
      timeoutMs: 12_345,
      logScope: 'lifecycle-admission-test',
    });
    logMocks.started.mockImplementationOnce(async () => {
      sequence.push('durable-start');
    });

    const running = lifecycle.withProviderSession({ q: 'x' }, { prepare, run, close });
    await Promise.resolve();
    expect(logMocks.started).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(timerSpy).not.toHaveBeenCalledWith(expect.any(Function), 12_345);

    permit.resolve({
      mode: 'enforce',
      laneId: 'xiaomi',
      borrowedFromTaskRunId: null,
      assertProviderStartAllowed,
      completeStartup,
      release,
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(logMocks.started).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(timerSpy).not.toHaveBeenCalledWith(expect.any(Function), 12_345);

    startup.resolve(undefined);
    await expect(running).resolves.toBe('provider-result');
    expect(logMocks.started).toHaveBeenCalledTimes(1);
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 12_345);
    expect(run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(completeStartup).toHaveBeenCalledTimes(1);
    expect(assertProviderStartAllowed).toHaveBeenCalledTimes(6);
    expect(sequence).toEqual(['prepare', 'complete-startup', 'durable-start', 'run']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('clamps startup and execution to one absolute provider-session deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.now();
    const release = vi.fn(async () => {});
    admissionMocks.acquire.mockResolvedValueOnce({
      mode: 'enforce',
      laneId: 'xiaomi',
      borrowedFromTaskRunId: null,
      assertProviderStartAllowed: vi.fn(),
      completeStartup: vi.fn(async () => {}),
      release,
    });
    const timerSpy = vi.spyOn(global, 'setTimeout');
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'absolute-provider-session-deadline',
      timeoutMs: 5_000,
      providerSessionDeadlineAt: startedAt + 900,
      logScope: 'lifecycle-admission-test',
    });
    expect(lifecycle.providerPhaseTimeoutMs(40_000)).toBe(900);
    vi.setSystemTime(startedAt + 250);
    expect(lifecycle.providerPhaseTimeoutMs(40_000)).toBe(650);

    await expect(
      lifecycle.withProviderSession(
        { q: 'x' },
        { prepare: async () => {}, run: async () => 'ok', close: async () => {} },
      ),
    ).resolves.toBe('ok');
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 650);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fences an SDK success that arrives after the absolute session deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.now();
    const release = vi.fn(async () => {});
    admissionMocks.acquire.mockResolvedValueOnce({
      mode: 'enforce',
      laneId: 'xiaomi',
      borrowedFromTaskRunId: null,
      assertProviderStartAllowed: vi.fn(),
      completeStartup: vi.fn(async () => {}),
      release,
    });
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'deadline-after-provider-success',
      timeoutMs: 5_000,
      providerSessionDeadlineAt: startedAt + 500,
      logScope: 'lifecycle-admission-test',
    });

    await expect(
      lifecycle.withProviderSession(
        { q: 'x' },
        {
          prepare: async () => {},
          run: async () => {
            vi.setSystemTime(startedAt + 500);
            return 'late-success';
          },
          close: async () => {},
        },
      ),
    ).rejects.toThrow('provider session wall-clock budget elapsed during query');
    expect(lifecycle.started).toBe(true);
    expect(lifecycle.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rechecks the permit lease after the SDK reports success', async () => {
    const leaseError = new ProviderSessionAdmissionError({
      reason: 'lease_lost',
      laneId: 'xiaomi',
      taskRunId: 'lease-lost-after-provider-success',
    });
    let assertionCount = 0;
    const assertProviderStartAllowed = vi.fn(() => {
      assertionCount += 1;
      if (assertionCount === 6) throw leaseError;
    });
    const release = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    admissionMocks.acquire.mockResolvedValueOnce({
      mode: 'enforce',
      laneId: 'xiaomi',
      borrowedFromTaskRunId: null,
      assertProviderStartAllowed,
      completeStartup: vi.fn(async () => {}),
      release,
    });
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'lease-lost-after-provider-success',
      timeoutMs: 5_000,
      logScope: 'lifecycle-admission-test',
    });

    await expect(
      lifecycle.withProviderSession(
        { q: 'x' },
        { prepare: async () => {}, run: async () => 'late-success', close },
      ),
    ).rejects.toBe(leaseError);
    expect(lifecycle.started).toBe(true);
    expect(assertProviderStartAllowed).toHaveBeenCalledTimes(6);
    expect(close).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not reuse the retry-start deadline as an in-flight execution cutoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.now();
    const release = vi.fn(async () => {});
    admissionMocks.acquire.mockResolvedValueOnce({
      mode: 'enforce',
      laneId: 'xiaomi',
      borrowedFromTaskRunId: null,
      assertProviderStartAllowed: vi.fn(),
      completeStartup: vi.fn(async () => {}),
      release,
    });
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'retry-start-is-not-execution-deadline',
      timeoutMs: 5_000,
      providerStartDeadlineAt: startedAt + 500,
      logScope: 'lifecycle-admission-test',
    });

    await expect(
      lifecycle.withProviderSession(
        { q: 'x' },
        {
          prepare: async () => {},
          run: async () => {
            vi.setSystemTime(startedAt + 500);
            return 'started-in-time';
          },
          close: async () => {},
        },
      ),
    ).resolves.toBe('started-in-time');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not let a startup-transition failure manufacture a durable attempt', async () => {
    const transitionError = new ProviderSessionAdmissionError({
      reason: 'control_plane_unavailable',
      laneId: 'xiaomi',
      taskRunId: 'startup-transition-failed',
    });
    const release = vi.fn(async () => {});
    admissionMocks.acquire.mockResolvedValueOnce({
      mode: 'enforce',
      laneId: 'xiaomi',
      borrowedFromTaskRunId: null,
      assertProviderStartAllowed: vi.fn(),
      completeStartup: vi.fn(async () => {
        throw transitionError;
      }),
      release,
    });
    const run = vi.fn(async () => 'must-not-run');
    const close = vi.fn(async () => {});
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'startup-transition-failed',
      timeoutMs: 1_000,
      logScope: 'lifecycle-admission-test',
    });

    await expect(
      lifecycle.withProviderSession({ q: 'x' }, { prepare: async () => {}, run, close }),
    ).rejects.toBe(transitionError);
    expect(logMocks.started).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
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

    await expect(
      lifecycle.withProviderSession(
        { q: 'x' },
        { prepare: async () => {}, run: async () => 'no', close: async () => {} },
      ),
    ).rejects.toMatchObject({
      reason: 'wait_timeout',
    });
    expect(lifecycle.started).toBe(false);
    expect(logMocks.started).not.toHaveBeenCalled();
  });

  it('closes the warm SDK without a durable row when startup crosses the retry deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.now();
    const startup = deferred<void>();
    const release = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    admissionMocks.acquire.mockResolvedValueOnce({
      mode: 'enforce',
      laneId: 'xiaomi',
      borrowedFromTaskRunId: null,
      assertProviderStartAllowed: vi.fn(),
      completeStartup: vi.fn(async () => {}),
      release,
    });
    const run = vi.fn(async () => 'must-not-run');
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'deadline-during-sdk-startup',
      timeoutMs: 1_000,
      providerStartDeadlineAt: startedAt + 500,
      logScope: 'lifecycle-admission-test',
    });

    const running = lifecycle.withProviderSession(
      { q: 'x' },
      { prepare: () => startup.promise, run, close },
    );
    await Promise.resolve();
    expect(logMocks.started).not.toHaveBeenCalled();
    vi.setSystemTime(startedAt + 500);
    startup.resolve(undefined);

    await expect(running).rejects.toMatchObject({ reason: 'wait_timeout' });
    expect(lifecycle.started).toBe(false);
    expect(logMocks.started).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
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
      assertProviderStartAllowed: vi.fn(),
      completeStartup: vi.fn(async () => {}),
      release,
    });
    const run = vi.fn(async () => 'must-not-run');
    const close = vi.fn(async () => {});
    const lifecycle = createRunLifecycle({
      db: {} as never,
      kind: 'AttributionTask',
      taskRunId: 'deadline-during-durable-start',
      timeoutMs: 1_000,
      providerStartDeadlineAt: startedAt + 500,
      logScope: 'lifecycle-admission-test',
    });

    const running = lifecycle.withProviderSession(
      { q: 'x' },
      { prepare: async () => {}, run, close },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(logMocks.started).toHaveBeenCalledTimes(1);
    vi.setSystemTime(startedAt + 500);
    startWrite.resolve(undefined);

    await expect(running).rejects.toMatchObject({ reason: 'wait_timeout' });
    expect(lifecycle.started).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
