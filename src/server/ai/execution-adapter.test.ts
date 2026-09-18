import type { Query, SDKUserMessage, WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  SdkPreparedQuery,
  explicitProviderRouting,
  resolveExecutionAdapter,
} from './execution-adapter';
import { transientRetryEnabled } from './run-lifecycle';

describe('resolveExecutionAdapter — P0 seam (YUK-1013)', () => {
  it('resolves to the sdk adapter when no binding is set', () => {
    expect(resolveExecutionAdapter().id).toBe('sdk');
    expect(resolveExecutionAdapter({}).id).toBe('sdk');
    expect(resolveExecutionAdapter({ model: 'mimo-v2.5-pro' }).id).toBe('sdk');
    expect(resolveExecutionAdapter({ adapter: 'sdk' }).id).toBe('sdk');
  });

  it('fails closed on an unimplemented adapter pin', () => {
    expect(() => resolveExecutionAdapter({ adapter: 'pi' })).toThrow(
      /ExecutionAdapter 'pi' is not implemented yet/,
    );
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
