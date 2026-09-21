import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ExecutionAdapter,
  __setPiAdapterForTests,
  explicitProviderRouting,
  resolveExecutionAdapter,
} from './execution-adapter';
import type { ResolvedProvider } from './providers';
import { transientRetryEnabled } from './run-lifecycle';
import type { Options } from './sdk-types';

const RESOLVED: ResolvedProvider = {
  authMode: 'key',
  provider: 'xiaomi',
  model: 'mimo-v2.5-pro',
  apiKey: 'sk-test-key',
};

const PI_RESOLVED: ResolvedProvider = {
  authMode: 'key',
  provider: 'opencode-go',
  model: 'deepseek-v4-pro',
  apiKey: 'sk-test-key',
};

afterEach(() => {
  vi.unstubAllEnvs();
  __setPiAdapterForTests(undefined);
});

describe('resolveExecutionAdapter — pi-only guard (YUK-1025)', () => {
  it('resolves the pi adapter for every provider/kind', () => {
    expect(resolveExecutionAdapter(undefined, RESOLVED, 'SolutionGenerateTask').id).toBe('pi');
    expect(resolveExecutionAdapter({}, RESOLVED, 'SolutionGenerateTask').id).toBe('pi');
    expect(resolveExecutionAdapter({ adapter: 'pi' }, PI_RESOLVED, 'CopilotTask').id).toBe('pi');
    expect(resolveExecutionAdapter(undefined, RESOLVED, 'ResearchMeetingDirectorTask').id).toBe(
      'pi',
    );
  });

  it('fails closed on a stale non-pi adapter pin', () => {
    expect(() =>
      resolveExecutionAdapter({ adapter: 'sdk' } as never, RESOLVED, 'SolutionGenerateTask'),
    ).toThrow(/retired in YUK-1025/);
    expect(() =>
      resolveExecutionAdapter({ adapter: 'bogus' } as never, RESOLVED, 'CopilotTask'),
    ).toThrow(/retired in YUK-1025/);
  });

  it('honours the test-only adapter swap and restores cleanly', () => {
    const fake: ExecutionAdapter = {
      id: 'pi',
      startup: vi.fn(async () => ({
        query: () => (async function* () {})(),
        close: async () => {},
      })),
    };
    __setPiAdapterForTests(fake);
    expect(resolveExecutionAdapter(undefined, RESOLVED, 'SolutionGenerateTask')).toBe(fake);
    __setPiAdapterForTests(undefined);
    expect(resolveExecutionAdapter(undefined, RESOLVED, 'SolutionGenerateTask')).not.toBe(fake);
  });
});

describe('explicitProviderRouting — explicit > env > registry layering', () => {
  it('returns undefined when neither layer names a field', () => {
    expect(explicitProviderRouting({})).toBeUndefined();
    expect(explicitProviderRouting({ override: {}, modelBinding: {} })).toBeUndefined();
  });

  it('uses the binding fields when override is absent', () => {
    expect(
      explicitProviderRouting({ modelBinding: { provider: 'xiaomi', model: 'mimo-v2.5' } }),
    ).toEqual({ provider: 'xiaomi', model: 'mimo-v2.5' });
    expect(explicitProviderRouting({ modelBinding: { model: 'mimo-v2.5' } })).toEqual({
      provider: undefined,
      model: 'mimo-v2.5',
    });
  });

  it('lets ctx.override (escape hatch) win per-field over the binding', () => {
    expect(
      explicitProviderRouting({
        override: { provider: 'anthropic-sub' },
        modelBinding: { provider: 'xiaomi', model: 'mimo-v2.5' },
      }),
    ).toEqual({ provider: 'anthropic-sub', model: 'mimo-v2.5' });
    expect(
      explicitProviderRouting({
        override: { model: 'mimo-v2.5-pro' },
        modelBinding: { provider: 'xiaomi', model: 'mimo-v2.5' },
      }),
    ).toEqual({ provider: 'xiaomi', model: 'mimo-v2.5-pro' });
  });
});

describe('PiAgentAdapter — startup guards', () => {
  it('fails closed when options.resume names a pi-owned session id without replay', async () => {
    const adapter = resolveExecutionAdapter(undefined, PI_RESOLVED, 'SolutionGenerateTask');
    await expect(
      adapter.startup({
        options: { resume: 'pi:abc-123' } as Options,
        initializeTimeoutMs: 1_000,
        resolved: PI_RESOLVED,
        runId: 'task_run_x',
        kind: 'SolutionGenerateTask',
      }),
    ).rejects.toThrow();
  });
});

describe('transientRetryEnabled — modelBinding pins routing like override', () => {
  it('stays off when the binding pins provider or model', () => {
    expect(
      transientRetryEnabled({ enableTransientRetry: true, modelBinding: { provider: 'xiaomi' } }),
    ).toBe(false);
    expect(
      transientRetryEnabled({ enableTransientRetry: true, modelBinding: { model: 'mimo-v2.5' } }),
    ).toBe(false);
  });

  it('stays on when the binding only carries non-routing fields', () => {
    expect(
      transientRetryEnabled({ enableTransientRetry: true, modelBinding: { effort: 'high' } }),
    ).toBe(true);
    expect(
      transientRetryEnabled({ enableTransientRetry: true, modelBinding: { adapter: 'pi' } }),
    ).toBe(true);
  });
});
