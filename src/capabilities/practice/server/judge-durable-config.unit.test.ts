// YUK-594 (durable judge main path) — durable-config env readers unit tests (no DB).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  judgeDurableEnabled,
  judgeFallbackProvider,
  resolveDurableProviderOverride,
} from './judge-durable-config';

const SNAPSHOT = { ...process.env };
function reset() {
  process.env = { ...SNAPSHOT };
}
beforeEach(reset);
afterEach(reset);

describe('judgeDurableEnabled', () => {
  it('defaults OFF (dark-ship)', () => {
    process.env.JUDGE_DURABLE_ENABLED = undefined;
    expect(judgeDurableEnabled()).toBe(false);
  });
  it('ON for 1 / true (shared parseFlag grammar)', () => {
    process.env.JUDGE_DURABLE_ENABLED = '1';
    expect(judgeDurableEnabled()).toBe(true);
    process.env.JUDGE_DURABLE_ENABLED = 'true';
    expect(judgeDurableEnabled()).toBe(true);
  });
  it('OFF for unrecognized / explicit false', () => {
    process.env.JUDGE_DURABLE_ENABLED = 'false';
    expect(judgeDurableEnabled()).toBe(false);
    process.env.JUDGE_DURABLE_ENABLED = 'nonsense';
    expect(judgeDurableEnabled()).toBe(false);
  });
});

describe('judgeFallbackProvider', () => {
  it('defaults to anthropic-sub', () => {
    process.env.JUDGE_FALLBACK_PROVIDER = undefined;
    expect(judgeFallbackProvider()).toBe('anthropic-sub');
  });
  it('empty string disables cross-provider fallback (undefined)', () => {
    process.env.JUDGE_FALLBACK_PROVIDER = '';
    expect(judgeFallbackProvider()).toBeUndefined();
  });
  it('honors an explicit wired provider', () => {
    process.env.JUDGE_FALLBACK_PROVIDER = 'xiaomi';
    expect(judgeFallbackProvider()).toBe('xiaomi');
  });
  it('degrades (returns undefined, does NOT throw) on an unknown provider name', () => {
    process.env.JUDGE_FALLBACK_PROVIDER = 'bogus';
    expect(() => judgeFallbackProvider()).not.toThrow();
    expect(judgeFallbackProvider()).toBeUndefined();
  });
  it('degrades on a reserved-but-not-wired provider (openrouter)', () => {
    process.env.JUDGE_FALLBACK_PROVIDER = 'openrouter';
    expect(judgeFallbackProvider()).toBeUndefined();
  });

  // #4 (codex) — this lane hands `RunTaskCtx.override` a provider with NO model. A wired
  // provider whose registry default model is the mimo id ('anthropic', 'zhipu') would then
  // be paired with that mimo model against its own endpoint and fail every time — a
  // guaranteed-dead final retry dressed up as a fallback. Reuses the single-source
  // `providerRequiresExplicitModel` predicate (YUK-608 / #1062), no second copy of the rule.
  it.each(['anthropic', 'zhipu'])(
    'degrades on a wired provider that needs an explicit model (%s)',
    (provider) => {
      process.env.JUDGE_FALLBACK_PROVIDER = provider;
      expect(judgeFallbackProvider()).toBeUndefined();
    },
  );

  it('still honors providers with a runnable built-in default model', () => {
    process.env.JUDGE_FALLBACK_PROVIDER = 'anthropic-sub';
    expect(judgeFallbackProvider()).toBe('anthropic-sub');
    process.env.JUDGE_FALLBACK_PROVIDER = 'xiaomi';
    expect(judgeFallbackProvider()).toBe('xiaomi');
  });
});

describe('resolveDurableProviderOverride (lane decision)', () => {
  it('no override before the final delivery (bounded)', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    expect(resolveDurableProviderOverride({ retryCount: 0, retryLimit: 2 })).toBeUndefined();
    expect(resolveDurableProviderOverride({ retryCount: 1, retryLimit: 2 })).toBeUndefined();
  });
  it('crosses to anthropic-sub on the final delivery when its token is configured', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    expect(resolveDurableProviderOverride({ retryCount: 2, retryLimit: 2 })).toBe('anthropic-sub');
  });
  it('bounded degrade: does NOT cross when the fallback token is missing', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
    expect(resolveDurableProviderOverride({ retryCount: 2, retryLimit: 2 })).toBeUndefined();
  });
  it('respects a disabled fallback (JUDGE_FALLBACK_PROVIDER="")', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.JUDGE_FALLBACK_PROVIDER = '';
    expect(resolveDurableProviderOverride({ retryCount: 2, retryLimit: 2 })).toBeUndefined();
  });
});
