// YUK-365 — provider resolution: key vs oauth authMode + the AI_PROVIDER_OVERRIDE
// switchable subscription lane. Pure no-DB unit: resolveTaskProvider imports only
// the registry + reads process.env, so we stub env and assert the resolved shape.
//
// SECURITY: every test uses a DUMMY token VALUE set in-test. The real
// CLAUDE_CODE_OAUTH_TOKEN (in .env.local) is never read, printed, or relied upon.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_SUB_DEFAULT_MODEL, resolveTaskProvider } from './providers';

// AttributionTask defaults to xiaomi/mimo-v2.5-pro in the registry — a stable
// baseline for the "default behaviour unchanged" assertions.
const KIND = 'AttributionTask';

describe('resolveTaskProvider — default (key auth, mimo)', () => {
  beforeEach(() => {
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
    vi.stubEnv('AI_PROVIDER_MODEL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves to xiaomi/mimo with authMode "key" and the mimo baseUrl', () => {
    const resolved = resolveTaskProvider(KIND);
    expect(resolved.authMode).toBe('key');
    expect(resolved.provider).toBe('xiaomi');
    expect(resolved.model).toBe('mimo-v2.5-pro');
    if (resolved.authMode !== 'key') throw new Error('expected key authMode');
    expect(resolved.apiKey).toBe('sk-test-key');
    expect(resolved.baseUrl).toBe('https://api.xiaomimimo.com/anthropic');
  });

  it('throws clearly when the key env is missing (current behaviour preserved)', () => {
    vi.stubEnv('XIAOMI_API_KEY', '');
    expect(() => resolveTaskProvider(KIND)).toThrow(/XIAOMI_API_KEY is required/);
  });

  it('honours an explicit per-call model override on the default provider', () => {
    const resolved = resolveTaskProvider(KIND, { model: 'mimo-v2.5' });
    expect(resolved.model).toBe('mimo-v2.5');
    expect(resolved.provider).toBe('xiaomi');
  });
});

describe('resolveTaskProvider — AI_PROVIDER_OVERRIDE=anthropic-sub (subscription OAuth lane)', () => {
  beforeEach(() => {
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'anthropic-sub');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'dummy-oauth-token-not-real');
    vi.stubEnv('AI_PROVIDER_MODEL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes to anthropic-sub: authMode "oauth", Opus 4.8, no baseUrl/apiKey', () => {
    const resolved = resolveTaskProvider(KIND);
    expect(resolved.authMode).toBe('oauth');
    expect(resolved.provider).toBe('anthropic-sub');
    expect(resolved.model).toBe('claude-opus-4-8');
    expect(resolved.model).toBe(ANTHROPIC_SUB_DEFAULT_MODEL);
    if (resolved.authMode !== 'oauth') throw new Error('expected oauth authMode');
    // The resolved record references the token by ENV-VAR NAME, never the value.
    expect(resolved.oauthTokenEnv).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    // No key-auth fields leak onto the oauth arm.
    expect('apiKey' in resolved).toBe(false);
    expect('baseUrl' in resolved).toBe(false);
  });

  it('is GLOBAL — applies to any task kind, not just one', () => {
    const a = resolveTaskProvider('AttributionTask');
    const b = resolveTaskProvider('CopilotTask');
    expect(a.provider).toBe('anthropic-sub');
    expect(b.provider).toBe('anthropic-sub');
    expect(a.model).toBe('claude-opus-4-8');
    expect(b.model).toBe('claude-opus-4-8');
  });

  it('throws a clear error when CLAUDE_CODE_OAUTH_TOKEN is unset', () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    expect(() => resolveTaskProvider(KIND)).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN is required.*subscription-OAuth/s,
    );
  });

  it('allows AI_PROVIDER_MODEL to override the Opus 4.8 default on the oauth lane', () => {
    vi.stubEnv('AI_PROVIDER_MODEL', 'claude-opus-4-8-custom');
    const resolved = resolveTaskProvider(KIND);
    expect(resolved.provider).toBe('anthropic-sub');
    expect(resolved.model).toBe('claude-opus-4-8-custom');
  });

  it('an explicit per-call override arg still beats the env switch', () => {
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    const resolved = resolveTaskProvider(KIND, { provider: 'xiaomi', model: 'mimo-v2.5' });
    expect(resolved.provider).toBe('xiaomi');
    expect(resolved.authMode).toBe('key');
    expect(resolved.model).toBe('mimo-v2.5');
  });
});

describe('resolveTaskProvider — AI_PROVIDER_OVERRIDE validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when AI_PROVIDER_OVERRIDE names an unknown provider', () => {
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'not-a-provider');
    expect(() => resolveTaskProvider(KIND)).toThrow(/is not a known provider/);
  });
});

// Finding 4 (Codex review P2): an env override to a non-mimo provider without
// AI_PROVIDER_MODEL must NOT silently carry the task's registry mimo default onto
// a non-mimo endpoint. It must throw a clear config error so the misconfig surfaces.
describe('resolveTaskProvider — non-sub override model guard (Finding 4)', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-anthropic-key');
    vi.stubEnv('AI_PROVIDER_MODEL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when AI_PROVIDER_OVERRIDE=anthropic has no AI_PROVIDER_MODEL (would keep the mimo default)', () => {
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'anthropic');
    // The guard fires BEFORE the "reserved but not implemented" branch, so the
    // error is the model-config one, not the not-implemented one.
    expect(() => resolveTaskProvider(KIND)).toThrow(
      /selects a non-mimo provider, but no AI_PROVIDER_MODEL is set/,
    );
  });

  it('passes the model guard once AI_PROVIDER_MODEL is set (then the provider-specific path runs)', () => {
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'anthropic');
    vi.stubEnv('AI_PROVIDER_MODEL', 'claude-opus-4-8');
    // anthropic-direct is wired only as a key provider that currently reaches the
    // resolved record (it IS in the implemented set), so this resolves cleanly with
    // the named model rather than the mimo default.
    const resolved = resolveTaskProvider(KIND);
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.authMode).toBe('key');
    expect(resolved.model).toBe('claude-opus-4-8');
  });

  it('does NOT trip the guard for AI_PROVIDER_OVERRIDE=xiaomi (mimo endpoint accepts the mimo default)', () => {
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'xiaomi');
    const resolved = resolveTaskProvider(KIND);
    expect(resolved.provider).toBe('xiaomi');
    expect(resolved.model).toBe('mimo-v2.5-pro');
  });

  it('does NOT trip the guard for AI_PROVIDER_OVERRIDE=anthropic-sub (has its own Opus 4.8 default)', () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'dummy-oauth-token-not-real');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'anthropic-sub');
    const resolved = resolveTaskProvider(KIND);
    expect(resolved.provider).toBe('anthropic-sub');
    expect(resolved.model).toBe('claude-opus-4-8');
  });

  it('a per-call override.provider to a non-mimo provider is NOT subject to the env-switch guard (dev escape hatch)', () => {
    // The guard only applies when the provider came from the env switch, not from an
    // explicit per-call override arg — that path is the test/dev escape hatch and is
    // expected to pass its own model. Here we pass the model too, so it resolves.
    const resolved = resolveTaskProvider(KIND, { provider: 'anthropic', model: 'claude-opus-4-8' });
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.model).toBe('claude-opus-4-8');
  });
});
