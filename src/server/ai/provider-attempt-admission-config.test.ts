import { describe, expect, it } from 'vitest';
import { resolveProviderAttemptAdmission } from './provider-attempt-admission-config';

const POLICY = JSON.stringify({
  'glm.memory-reconcile': { maxConcurrentAttempts: 2, maxAttemptStartsPerMinute: 5 },
});

describe('provider attempt admission config', () => {
  it('defaults every lane to off when config is absent', () => {
    expect(resolveProviderAttemptAdmission({}, 'glm.memory-reconcile')).toEqual({
      mode: 'off',
      policy: null,
    });
  });

  it('enables only explicitly listed closed lanes', () => {
    const env = {
      AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'observe',
      AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: POLICY,
    };
    expect(resolveProviderAttemptAdmission(env, 'glm.memory-reconcile')).toMatchObject({
      mode: 'observe',
      policy: { maxConcurrentAttempts: 2, maxAttemptStartsPerMinute: 5 },
    });
    expect(resolveProviderAttemptAdmission(env, 'dashscope.embedding')).toEqual({
      mode: 'off',
      policy: null,
    });
  });

  it('rejects unknown lanes and policy fields', () => {
    expect(() =>
      resolveProviderAttemptAdmission(
        {
          AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'enforce',
          AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: JSON.stringify({
            'glm.future-lane': { maxConcurrentAttempts: 1, maxAttemptStartsPerMinute: 1 },
          }),
        },
        'glm.memory-reconcile',
      ),
    ).toThrow();
    expect(() =>
      resolveProviderAttemptAdmission(
        {
          AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'enforce',
          AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: JSON.stringify({
            'glm.memory-reconcile': {
              maxConcurrentAttempts: 1,
              maxAttemptStartsPerMinute: 1,
              queue: true,
            },
          }),
        },
        'glm.memory-reconcile',
      ),
    ).toThrow();
  });

  it('rolls every configured lane back to off with the mode switch', () => {
    expect(
      resolveProviderAttemptAdmission(
        {
          AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'off',
          AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: POLICY,
        },
        'glm.memory-reconcile',
      ),
    ).toEqual({ mode: 'off', policy: null });
  });

  it('keeps rollback available when stale policy JSON is malformed', () => {
    expect(
      resolveProviderAttemptAdmission(
        {
          AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'off',
          AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: '{stale-json',
        },
        'glm.memory-reconcile',
      ),
    ).toEqual({ mode: 'off', policy: null });
  });
});
