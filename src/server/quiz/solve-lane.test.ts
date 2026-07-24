// YUK-608 (异源 solve/verify) — scoped solve_check provider/model override resolver.
// Pure env read + fail-open pre-flight (no DB / AI / pg-boss). Asserts:
//   - env unset → {} (default-lane byte-identical, no warn)
//   - known provider whose credential lane is wired → { provider } (+ model)
//   - model-only override (no provider) → { model } (same-provider swap)
//   - unknown provider → {} + warn (fail-open, drops any model too)
//   - known provider but credential env absent → {} + warn (fail-open)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VERIFY_SOLVE_MODEL_ENV,
  VERIFY_SOLVE_PROVIDER_ENV,
  resolveSolveOverrideFromEnv,
} from './solve-lane';

// The credential env `anthropic-sub` (OAuth lane) requires; isProviderLaneReady reads it.
const SUB_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

const TOUCHED = [VERIFY_SOLVE_PROVIDER_ENV, VERIFY_SOLVE_MODEL_ENV, SUB_TOKEN_ENV] as const;

describe('resolveSolveOverrideFromEnv (YUK-608 异源 solve/verify lane)', () => {
  beforeEach(() => {
    // Clean baseline: stub every touched var to undefined (vi.stubEnv DELETES on undefined —
    // unlike `process.env.X = undefined`, which sets the literal string "undefined").
    for (const key of TOUCHED) vi.stubEnv(key, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns {} and does not warn when neither env is set (default-lane invariant)', () => {
    const warn = vi.fn();
    expect(resolveSolveOverrideFromEnv(warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a known provider through when its credential lane is wired', () => {
    vi.stubEnv(VERIFY_SOLVE_PROVIDER_ENV, 'anthropic-sub');
    vi.stubEnv(SUB_TOKEN_ENV, 'oauth-token-xyz');
    const warn = vi.fn();
    expect(resolveSolveOverrideFromEnv(warn)).toEqual({ provider: 'anthropic-sub' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('carries an explicit model alongside the provider', () => {
    vi.stubEnv(VERIFY_SOLVE_PROVIDER_ENV, 'anthropic-sub');
    vi.stubEnv(VERIFY_SOLVE_MODEL_ENV, 'claude-opus-4-8');
    vi.stubEnv(SUB_TOKEN_ENV, 'oauth-token-xyz');
    expect(resolveSolveOverrideFromEnv(vi.fn())).toEqual({
      provider: 'anthropic-sub',
      model: 'claude-opus-4-8',
    });
  });

  it('supports a model-only override (same-provider swap, no provider)', () => {
    vi.stubEnv(VERIFY_SOLVE_MODEL_ENV, 'mimo-v2.5-some-variant');
    const warn = vi.fn();
    expect(resolveSolveOverrideFromEnv(warn)).toEqual({ model: 'mimo-v2.5-some-variant' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('fail-opens (drops the WHOLE override) + warns on an unknown provider', () => {
    vi.stubEnv(VERIFY_SOLVE_PROVIDER_ENV, 'not-a-provider');
    vi.stubEnv(VERIFY_SOLVE_MODEL_ENV, 'claude-opus-4-8');
    const warn = vi.fn();
    // Unknown provider drops the model too — it was chosen for that provider and could
    // 404 on the default lane.
    expect(resolveSolveOverrideFromEnv(warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('not a known provider');
  });

  it('fail-opens + warns when a known provider lane is not configured (credential env missing)', () => {
    vi.stubEnv(VERIFY_SOLVE_PROVIDER_ENV, 'anthropic-sub');
    // CLAUDE_CODE_OAUTH_TOKEN intentionally left unset by beforeEach.
    const warn = vi.fn();
    expect(resolveSolveOverrideFromEnv(warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('not configured');
  });
});
