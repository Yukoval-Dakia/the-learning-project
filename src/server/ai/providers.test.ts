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
