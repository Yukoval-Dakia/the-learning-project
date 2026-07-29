import { validateShadowProviderEnv } from '@/server/grounding-gate/preflight';
import { describe, expect, it } from 'vitest';

const providerEnv = {
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-token',
  XIAOMI_API_KEY: 'xiaomi-test-key',
};

describe('validateShadowProviderEnv', () => {
  it('accepts the documented Opus induction plus Mimo grouping lanes', () => {
    expect(() => validateShadowProviderEnv(providerEnv)).not.toThrow();
  });

  it.each(['AI_PROVIDER_OVERRIDE', 'AI_PROVIDER_MODEL'])(
    'rejects a process-global %s before provider dispatch',
    (name) => {
      expect(() =>
        validateShadowProviderEnv({
          ...providerEnv,
          [name]: 'unexpected-global-switch',
        }),
      ).toThrow(`unset ${name}`);
    },
  );

  it('reports missing credential names without credential values', () => {
    expect(() =>
      validateShadowProviderEnv({
        CLAUDE_CODE_OAUTH_TOKEN: 'secret-oauth-value',
      }),
    ).toThrow('missing XIAOMI_API_KEY');
    try {
      validateShadowProviderEnv({
        CLAUDE_CODE_OAUTH_TOKEN: 'secret-oauth-value',
      });
    } catch (error) {
      expect(String(error)).not.toContain('secret-oauth-value');
    }
  });
});
