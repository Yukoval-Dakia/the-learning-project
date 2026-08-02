import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireProviderSession,
  resolveProviderSessionAdmissionPlan,
} from './provider-session-admission';

const VALID_POLICIES = JSON.stringify({
  xiaomi: {
    maxConcurrentSessions: 4,
    maxSessionStartsPerMinute: 30,
    maxQueuedSessions: 40,
    maxWaitMs: 20_000,
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provider session admission configuration', () => {
  it('defaults off and lets explicit rollback ignore a malformed inactive policy', () => {
    expect(resolveProviderSessionAdmissionPlan('xiaomi', {})).toEqual({
      mode: 'off',
      laneId: 'xiaomi',
    });
    expect(
      resolveProviderSessionAdmissionPlan('xiaomi', {
        AI_PROVIDER_SESSION_ADMISSION_MODE: 'off',
        AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: '{broken',
      }),
    ).toEqual({ mode: 'off', laneId: 'xiaomi' });
  });

  it('parses a strict per-lane policy and keeps unlisted lanes explicitly off', () => {
    const env = {
      AI_PROVIDER_SESSION_ADMISSION_MODE: 'observe',
      AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: VALID_POLICIES,
    };
    const xiaomi = resolveProviderSessionAdmissionPlan('xiaomi', env);
    expect(xiaomi).toMatchObject({
      mode: 'observe',
      laneId: 'xiaomi',
      policy: {
        maxConcurrentSessions: 4,
        maxSessionStartsPerMinute: 30,
        maxQueuedSessions: 40,
        maxWaitMs: 20_000,
      },
    });
    expect(xiaomi.policy?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(resolveProviderSessionAdmissionPlan('anthropic', env)).toEqual({
      mode: 'off',
      laneId: 'anthropic',
    });
  });

  it('fails fast on mode, lane, key and numeric policy typos', () => {
    expect(() =>
      resolveProviderSessionAdmissionPlan('xiaomi', {
        AI_PROVIDER_SESSION_ADMISSION_MODE: 'enabled',
      }),
    ).toThrow(/off \| observe \| enforce/);
    expect(() =>
      resolveProviderSessionAdmissionPlan('xiaomi', {
        AI_PROVIDER_SESSION_ADMISSION_MODE: 'enforce',
        AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: JSON.stringify({
          imaginary: { maxConcurrentSessions: 1, maxSessionStartsPerMinute: 1 },
        }),
      }),
    ).toThrow(/unknown provider lane/);
    expect(() =>
      resolveProviderSessionAdmissionPlan('xiaomi', {
        AI_PROVIDER_SESSION_ADMISSION_MODE: 'enforce',
        AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: JSON.stringify({
          xiaomi: {
            maxConcurrentSessions: 1,
            maxSessionStartsPerMinute: 1,
            maxRequests: 1,
          },
        }),
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      resolveProviderSessionAdmissionPlan('xiaomi', {
        AI_PROVIDER_SESSION_ADMISSION_MODE: 'enforce',
        AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: JSON.stringify({
          xiaomi: { maxConcurrentSessions: 0, maxSessionStartsPerMinute: 1 },
        }),
      }),
    ).toThrow(/maxConcurrentSessions/);
  });
});

describe('provider session admission failure policy', () => {
  const policy = {
    laneId: 'xiaomi' as const,
    maxConcurrentSessions: 1,
    maxSessionStartsPerMinute: 1,
    maxQueuedSessions: 1,
    maxWaitMs: 100,
    fingerprint: 'unit-policy',
  };

  function request(mode: 'observe' | 'enforce') {
    const db = {
      transaction: vi.fn(async () => {
        throw new Error('postgres unavailable');
      }),
    } as never;
    return acquireProviderSession({
      db,
      kind: 'AttributionTask',
      taskRunId: `${mode}-control-plane`,
      executionTimeoutMs: 1_000,
      signal: new AbortController().signal,
      plan: { mode, laneId: 'xiaomi', policy },
      onLeaseLost: vi.fn(),
    });
  }

  it('observe is the only bounded fail-open mode', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const permit = await request('observe');
    expect(permit.mode).toBe('off');
    await permit.release();
  });

  it('enforce fails closed on control-plane ambiguity', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(request('enforce')).rejects.toEqual(
      expect.objectContaining({
        name: 'ProviderSessionAdmissionError',
        reason: 'control_plane_unavailable',
      }),
    );
  });

  it('bounds persistent lane-lock starvation and only observe fails open', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = (mode: 'observe' | 'enforce') => {
      const transaction = vi.fn(async () => undefined);
      const promise = acquireProviderSession({
        db: { transaction } as never,
        kind: 'AttributionTask',
        taskRunId: `${mode}-lock-starvation`,
        executionTimeoutMs: 1_000,
        signal: new AbortController().signal,
        plan: { mode, laneId: 'xiaomi', policy: { ...policy, maxWaitMs: 5 } },
        onLeaseLost: vi.fn(),
      });
      return { promise, transaction };
    };

    const observed = run('observe');
    await expect(observed.promise).resolves.toMatchObject({ mode: 'off' });
    expect(observed.transaction.mock.calls.length).toBeLessThan(5);

    const enforced = run('enforce');
    await expect(enforced.promise).rejects.toMatchObject({ reason: 'wait_timeout' });
    expect(enforced.transaction.mock.calls.length).toBeLessThan(5);
  });

  it('does not spin or touch Postgres when already cancelled before admission', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    controller.abort();
    const transaction = vi.fn(async () => undefined);

    await expect(
      acquireProviderSession({
        db: { transaction } as never,
        kind: 'AttributionTask',
        taskRunId: 'cancelled-before-admission',
        executionTimeoutMs: 1_000,
        signal: controller.signal,
        plan: { mode: 'enforce', laneId: 'xiaomi', policy },
        onLeaseLost: vi.fn(),
      }),
    ).rejects.toMatchObject({ reason: 'cancelled' });
    expect(transaction).not.toHaveBeenCalled();
  });
});
