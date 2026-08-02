import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const admissionMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  releases: [] as Array<ReturnType<typeof vi.fn>>,
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
        maxConcurrentSessions: 2,
        maxSessionStartsPerMinute: 20,
        maxQueuedSessions: 20,
        maxWaitMs: 1_000,
        fingerprint: 'runner-admission-test',
      },
    }),
    acquireProviderSession: admissionMocks.acquire,
  };
});

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
  queues: [] as unknown[][],
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkMocks.query,
  createSdkMcpServer: vi.fn(() => ({ type: 'sdk', name: '', instance: {} })),
  tool: vi.fn((name: string, description: string) => ({ name, description })),
}));

const logMocks = vi.hoisted(() => ({
  started: vi.fn(async () => {}),
  terminal: vi.fn(async (_db: unknown, _row: { status: string }) => true),
  retried: vi.fn(async () => true),
}));

vi.mock('@/server/ai/log', () => ({
  logMissingMcpServersWarning: vi.fn(),
  writeAiTaskRunStarted: logMocks.started,
  writeAiTaskAttemptFinished: logMocks.terminal,
  writeAiTaskRunRetried: logMocks.retried,
  writeToolCallLog: vi.fn(async () => 'tool-log-id'),
}));

import { RETRY_ELAPSED_CAP_MS } from './agent-run-error';
import { ProviderSessionAdmissionError } from './provider-session-admission';
import { runTask, streamTask, streamTaskCollecting } from './runner';

const fakeDb = {} as never;

function success(text = 'ok') {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    stop_reason: 'end_turn',
    total_cost_usd: 0.001,
    usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0 },
  };
}

function transientFailure() {
  return {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 503,
    result: 'temporary provider failure',
    stop_reason: 'stop_sequence',
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
  };
}

function assistant(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

describe('runner central provider-session seam', () => {
  beforeEach(() => {
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    admissionMocks.acquire.mockReset();
    admissionMocks.releases = [];
    admissionMocks.acquire.mockImplementation(async () => {
      const release = vi.fn(async () => {});
      admissionMocks.releases.push(release);
      return {
        mode: 'enforce' as const,
        laneId: 'xiaomi' as const,
        borrowedFromTaskRunId: null,
        release,
      };
    });
    sdkMocks.queues = [];
    sdkMocks.query.mockReset().mockImplementation(() => {
      const messages = sdkMocks.queues.shift() ?? [];
      return (async function* () {
        for (const message of messages) yield message;
      })();
    });
    logMocks.started.mockClear();
    logMocks.terminal.mockClear();
    logMocks.retried.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('re-admits each loom retry with a fresh attempt id and releases before settlement', async () => {
    sdkMocks.queues = [[transientFailure()], [success('recovered')]];
    const sequence: string[] = [];
    admissionMocks.acquire.mockImplementation(async (input: { taskRunId: string }) => {
      sequence.push(`acquire:${input.taskRunId}`);
      const release = vi.fn(async () => {
        sequence.push(`release:${input.taskRunId}`);
      });
      admissionMocks.releases.push(release);
      return {
        mode: 'enforce' as const,
        laneId: 'xiaomi' as const,
        borrowedFromTaskRunId: null,
        release,
      };
    });
    logMocks.terminal.mockImplementation(async (_db: unknown, row: { status: string }) => {
      sequence.push(`settle:${row.status}`);
      return true;
    });

    const result = await runTask(
      'StepsJudgeTask',
      { prompt: 'x' },
      { db: fakeDb, enableTransientRetry: true },
    );

    expect(result.text).toBe('recovered');
    expect(admissionMocks.acquire).toHaveBeenCalledTimes(2);
    const ids = admissionMocks.acquire.mock.calls.map(
      ([input]) => (input as { taskRunId: string }).taskRunId,
    );
    expect(new Set(ids).size).toBe(2);
    expect(admissionMocks.releases).toHaveLength(2);
    expect(admissionMocks.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(sequence.indexOf(`release:${ids[0]}`)).toBeLessThan(sequence.indexOf('settle:failure'));
    expect(sequence.indexOf(`release:${ids[1]}`)).toBeLessThan(sequence.indexOf('settle:success'));
    expect(logMocks.retried).toHaveBeenCalledTimes(1);
  });

  it('uses the same admitted seam for text stream and collecting stream', async () => {
    sdkMocks.queues = [
      [assistant('text-stream'), success('text-stream')],
      [assistant('collecting'), success('collecting')],
    ];
    const response = streamTask('AttributionTask', { q: 1 }, { db: fakeDb });
    await expect(response.text()).resolves.toContain('text-stream');
    const collected = await streamTaskCollecting(
      'AttributionTask',
      { q: 2 },
      { db: fakeDb },
      () => {},
    );

    expect(collected.text).toBe('collecting');
    expect(admissionMocks.acquire).toHaveBeenCalledTimes(2);
    expect(admissionMocks.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it('rejects collected text when admission fencing wins after the SDK result', async () => {
    sdkMocks.queues = [[assistant('must-not-persist'), success('must-not-persist')]];
    admissionMocks.acquire.mockImplementationOnce(
      async (input: {
        taskRunId: string;
        onLeaseLost: (error: ProviderSessionAdmissionError) => void;
      }) => {
        const release = vi.fn(async () => {
          input.onLeaseLost(
            new ProviderSessionAdmissionError({
              reason: 'lease_lost',
              laneId: 'xiaomi',
              taskRunId: input.taskRunId,
            }),
          );
        });
        admissionMocks.releases.push(release);
        return {
          mode: 'enforce' as const,
          laneId: 'xiaomi' as const,
          borrowedFromTaskRunId: null,
          release,
        };
      },
    );

    await expect(
      streamTaskCollecting(
        'AttributionTask',
        { q: 2 },
        { db: fakeDb, taskRunId: 'fenced-collecting' },
        () => {},
      ),
    ).rejects.toMatchObject({
      subtype: 'provider_admission',
      taskRunId: 'fenced-collecting',
    });

    expect(admissionMocks.releases).toHaveLength(1);
    expect(admissionMocks.releases[0]).toHaveBeenCalledTimes(1);
    expect(logMocks.terminal).toHaveBeenLastCalledWith(
      fakeDb,
      expect.objectContaining({ status: 'failure' }),
    );
  });

  it('never lets retry admission extend the existing elapsed provider-start gate', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.now();
    sdkMocks.queues = [[transientFailure()], [success('must-not-run')]];
    admissionMocks.acquire.mockImplementation(async () => {
      const release = vi.fn(async () => {});
      admissionMocks.releases.push(release);
      if (admissionMocks.releases.length === 2) {
        vi.setSystemTime(startedAt + RETRY_ELAPSED_CAP_MS);
      }
      return {
        mode: 'enforce' as const,
        laneId: 'xiaomi' as const,
        borrowedFromTaskRunId: null,
        release,
      };
    });

    await expect(
      runTask('StepsJudgeTask', { prompt: 'x' }, { db: fakeDb, enableTransientRetry: true }),
    ).rejects.toMatchObject({ reason: 'wait_timeout' });
    expect(sdkMocks.query).toHaveBeenCalledTimes(1);
    expect(logMocks.retried).not.toHaveBeenCalled();
    expect(logMocks.started).toHaveBeenCalledTimes(1);
    expect(admissionMocks.releases).toHaveLength(2);
    expect(admissionMocks.releases[1]).toHaveBeenCalledTimes(1);
  });

  it('rejects a pre-start admission timeout without SDK call or partial collecting output', async () => {
    admissionMocks.acquire.mockRejectedValue(
      new ProviderSessionAdmissionError({
        reason: 'wait_timeout',
        laneId: 'xiaomi',
        taskRunId: 'admission-timeout',
      }),
    );

    await expect(
      streamTaskCollecting(
        'AttributionTask',
        { q: 1 },
        { db: fakeDb, taskRunId: 'admission-timeout' },
        () => {},
      ),
    ).rejects.toMatchObject({ reason: 'wait_timeout' });
    expect(sdkMocks.query).not.toHaveBeenCalled();
    expect(logMocks.started).not.toHaveBeenCalled();
    expect(logMocks.terminal).not.toHaveBeenCalled();
  });
});
