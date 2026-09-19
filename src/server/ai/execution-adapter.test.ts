import type { Query, SDKUserMessage, WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SdkPreparedQuery,
  explicitProviderRouting,
  isPiEligibleKind,
  piAllowlistedKinds,
  resolveExecutionAdapter,
} from './execution-adapter';
import type { ResolvedProvider } from './providers';
import { transientRetryEnabled } from './run-lifecycle';

const SDK_RESOLVED: ResolvedProvider = {
  authMode: 'key',
  provider: 'xiaomi',
  model: 'mimo-v2.5-pro',
  apiKey: 'sk-test-key',
};

const PI_RESOLVED: ResolvedProvider = {
  authMode: 'key',
  provider: 'opencode-go',
  model: 'mimo-v2.5-pro',
  apiKey: 'sk-test-key',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveExecutionAdapter — P0 seam (YUK-1013)', () => {
  it('resolves to the sdk adapter when no binding is set', () => {
    expect(resolveExecutionAdapter(undefined, SDK_RESOLVED, 'SolutionGenerateTask').id).toBe('sdk');
    expect(resolveExecutionAdapter({}, SDK_RESOLVED, 'SolutionGenerateTask').id).toBe('sdk');
    expect(
      resolveExecutionAdapter({ model: 'mimo-v2.5-pro' }, SDK_RESOLVED, 'SolutionGenerateTask').id,
    ).toBe('sdk');
    expect(
      resolveExecutionAdapter({ adapter: 'sdk' }, SDK_RESOLVED, 'SolutionGenerateTask').id,
    ).toBe('sdk');
  });

  it('fails closed on an unknown adapter pin', () => {
    expect(() =>
      resolveExecutionAdapter({ adapter: 'bogus' as never }, SDK_RESOLVED, 'SolutionGenerateTask'),
    ).toThrow(/ExecutionAdapter 'bogus' is not implemented/);
  });
});

describe('resolveExecutionAdapter — pi gate (YUK-921 P1)', () => {
  it('rejects a pi pin on a non-pi-lane provider', () => {
    vi.stubEnv('AI_ADAPTER_PI_KINDS', 'SolutionGenerateTask');
    expect(() =>
      resolveExecutionAdapter({ adapter: 'pi' }, SDK_RESOLVED, 'SolutionGenerateTask'),
    ).toThrow(/ExecutionAdapter 'pi' does not serve provider 'xiaomi'/);
  });

  it('rejects a pi pin when the kind is not allowlisted', () => {
    expect(() =>
      resolveExecutionAdapter({ adapter: 'pi' }, PI_RESOLVED, 'SolutionGenerateTask'),
    ).toThrow(/Task kind 'SolutionGenerateTask' is not eligible/);
  });

  it('rejects a pi pin on a needsToolCall kind even when allowlisted', () => {
    vi.stubEnv('AI_ADAPTER_PI_KINDS', 'QuizGenTask');
    expect(() => resolveExecutionAdapter({ adapter: 'pi' }, PI_RESOLVED, 'QuizGenTask')).toThrow(
      /Task kind 'QuizGenTask' is not eligible/,
    );
  });

  it('resolves the pi adapter on pi provider + allowlisted single-shot kind', () => {
    vi.stubEnv('AI_ADAPTER_PI_KINDS', 'SolutionGenerateTask');
    expect(resolveExecutionAdapter({ adapter: 'pi' }, PI_RESOLVED, 'SolutionGenerateTask').id).toBe(
      'pi',
    );
  });

  it('rejects the sdk default on a pi-lane provider', () => {
    expect(() => resolveExecutionAdapter({}, PI_RESOLVED, 'SolutionGenerateTask')).toThrow(
      /Provider 'opencode-go' is served only by ExecutionAdapter 'pi'/,
    );
  });
});

describe('AI_ADAPTER_PI_KINDS parsing', () => {
  it('is empty when unset or blank', () => {
    vi.stubEnv('AI_ADAPTER_PI_KINDS', '');
    expect(piAllowlistedKinds().size).toBe(0);
    expect(isPiEligibleKind('SolutionGenerateTask')).toBe(false);
  });

  it('parses a comma-separated kind list and intersects with needsToolCall=false', () => {
    vi.stubEnv('AI_ADAPTER_PI_KINDS', ' SolutionGenerateTask , QuizGenTask ,,');
    expect([...piAllowlistedKinds()].sort()).toEqual(['QuizGenTask', 'SolutionGenerateTask']);
    expect(isPiEligibleKind('SolutionGenerateTask')).toBe(true);
    // Allowlisted but needsToolCall → still ineligible (tool loop is P2).
    expect(isPiEligibleKind('QuizGenTask')).toBe(false);
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
      transientRetryEnabled({ enableTransientRetry: true, modelBinding: { adapter: 'sdk' } }),
    ).toBe(true);
  });
});

describe('SdkPreparedQuery — close-order contract (byte-for-byte from pre-seam runner)', () => {
  function fakeWarmQuery() {
    const queryObj = {
      return: vi.fn(async (_v?: undefined) => ({}) as never),
      close: vi.fn(),
      [Symbol.asyncIterator]: () => (async function* () {})(),
    };
    const warm = {
      query: vi.fn(
        (_prompt: string | AsyncIterable<SDKUserMessage>) => queryObj as unknown as Query,
      ),
      close: vi.fn(),
    };
    return { warm: warm as unknown as WarmQuery, warmSpies: warm, queryObj };
  }

  it('closes the active query via return() when a prompt was submitted', async () => {
    const { warm, warmSpies, queryObj } = fakeWarmQuery();
    const prepared = new SdkPreparedQuery(warm);
    prepared.query('hi');
    await prepared.close();
    expect(queryObj.return).toHaveBeenCalledTimes(1);
    expect(queryObj.close).not.toHaveBeenCalled();
    expect(warmSpies.close).not.toHaveBeenCalled();
  });

  it('falls back to query.close() when return() rejects', async () => {
    const { warm, queryObj } = fakeWarmQuery();
    queryObj.return.mockRejectedValueOnce(new Error('return failed'));
    const prepared = new SdkPreparedQuery(warm);
    prepared.query('hi');
    await prepared.close();
    expect(queryObj.close).toHaveBeenCalledTimes(1);
  });

  it('closes the unused warm transport when no prompt was submitted', async () => {
    const { warm, warmSpies } = fakeWarmQuery();
    const prepared = new SdkPreparedQuery(warm);
    await prepared.close();
    expect(warmSpies.query).not.toHaveBeenCalled();
    expect(warmSpies.close).toHaveBeenCalledTimes(1);
  });
});
