import { afterEach, describe, expect, it } from 'vitest';
import { type ConfigSnapshot, replaceConfigSnapshot, resetTestConfig } from '@/core/config/store';
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

// ────────────────────────────────────────────────────────────────────────────
// YUK-1007 review P1-4 — 真实 consumer 的 DB 层生效回归。
// 迁移前 resolveProviderAttemptAdmission 直读 env 形参：hydrate 进快照的 DB 行
// 永远不被读到（面板写入→enforce 实际还是 off）。这里用 replaceConfigSnapshot
// 注入 hydrate 同形的 DB 行，env 形参留空——证明 DB 行驱动真实 consumer。
// ────────────────────────────────────────────────────────────────────────────
describe('provider attempt admission — DB-layer rows drive the real consumer (YUK-1007 P1-4)', () => {
  const EMPTY: ConfigSnapshot = { epoch: 0, entries: new Map(), hydratedAt: '' };

  afterEach(() => {
    replaceConfigSnapshot(EMPTY);
    resetTestConfig();
  });

  it('DB rows apply with env absent (was red: env-only reader returned off)', () => {
    replaceConfigSnapshot({
      epoch: 1,
      entries: new Map([
        ['AI_PROVIDER_ATTEMPT_ADMISSION_MODE', { value: 'observe', revision: 1, updatedAt: null }],
        [
          'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
          {
            value: {
              'glm.memory-reconcile': { maxConcurrentAttempts: 2, maxAttemptStartsPerMinute: 5 },
            },
            revision: 1,
            updatedAt: null,
          },
        ],
      ]),
      hydratedAt: 'x',
    });
    expect(resolveProviderAttemptAdmission({}, 'glm.memory-reconcile')).toMatchObject({
      mode: 'observe',
      policy: { maxConcurrentAttempts: 2, maxAttemptStartsPerMinute: 5 },
    });
    // 缺 lane：另一条 lane 不在 policies 里 → off（缺 lane 语义保留）。
    expect(resolveProviderAttemptAdmission({}, 'dashscope.embedding')).toEqual({
      mode: 'off',
      policy: null,
    });
  });

  it('DB row beats env (fallback ordering: DB > env > off)', () => {
    replaceConfigSnapshot({
      epoch: 1,
      entries: new Map([
        ['AI_PROVIDER_ATTEMPT_ADMISSION_MODE', { value: 'off', revision: 1, updatedAt: null }],
      ]),
      hydratedAt: 'x',
    });
    expect(
      resolveProviderAttemptAdmission(
        {
          AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'enforce',
          AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: POLICY,
        },
        'glm.memory-reconcile',
      ),
    ).toEqual({ mode: 'off', policy: null });
  });

  it('invalid DB mode still throws (no fail-open regression)', () => {
    replaceConfigSnapshot({
      epoch: 1,
      entries: new Map([
        ['AI_PROVIDER_ATTEMPT_ADMISSION_MODE', { value: 'enabled', revision: 1, updatedAt: null }],
      ]),
      hydratedAt: 'x',
    });
    expect(() => resolveProviderAttemptAdmission({}, 'glm.memory-reconcile')).toThrow();
  });

  it('DB policies with an unknown lane still throw', () => {
    replaceConfigSnapshot({
      epoch: 1,
      entries: new Map([
        ['AI_PROVIDER_ATTEMPT_ADMISSION_MODE', { value: 'enforce', revision: 1, updatedAt: null }],
        [
          'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
          {
            value: {
              'glm.future-lane': { maxConcurrentAttempts: 1, maxAttemptStartsPerMinute: 1 },
            },
            revision: 1,
            updatedAt: null,
          },
        ],
      ]),
      hydratedAt: 'x',
    });
    expect(() => resolveProviderAttemptAdmission({}, 'glm.memory-reconcile')).toThrow();
  });
});
