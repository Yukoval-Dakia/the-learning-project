/**
 * YUK-1007 review 修复 — registry env-parse 兼容测试（no-DB 车道，src/core glob）。
 *
 * 每个迁移 key 的 envParse 必须与「被替换的原 reader」对以下输入集合输出一致
 * （无 DB 行时）：{unset, '0', '1', 'true', 'false', '1e2', 'abc', ''}。
 * 旧语义逐 key 手工编码成 oracle（旧代码原文见 c4a8f94b3 的 diff）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_REGISTRY } from './registry';
import {
  type ConfigSnapshot,
  getConfig,
  getConfigFlag,
  replaceConfigSnapshot,
  resetTestConfig,
  resolveConfigValue,
} from './store';

const EMPTY_SNAPSHOT: ConfigSnapshot = { epoch: 0, entries: new Map(), hydratedAt: '' };

afterEach(() => {
  resetTestConfig();
  replaceConfigSnapshot(EMPTY_SNAPSHOT);
});

const INPUTS = [undefined, '0', '1', 'true', 'false', '1e2', 'abc', ''] as const;

/** 原 parseFlag（src/core/env-flags.ts）：true/1→true，false/0→false，其余→default。 */
function oldParseFlag(raw: string | undefined, defaultValue = false): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return defaultValue;
}

function envFor(envName: string, raw: string | undefined): NodeJS.ProcessEnv {
  return raw === undefined ? {} : ({ [envName]: raw } as NodeJS.ProcessEnv);
}

describe('PLACEMENT_PROBE_ENABLED — compose-pinned, raw==="true" literal semantics (P1-1)', () => {
  // 原 reader（迁移前 placement.ts）：process.env.PLACEMENT_PROBE_ENABLED === 'true'
  // 逐位字面量比较——'1'/'TRUE'/'abc'/'' 全部 false，区分大小写。
  it('env="true" resolves true (was red: unregistered key returned raw string → getConfigFlag false)', () => {
    expect(
      getConfigFlag('PLACEMENT_PROBE_ENABLED', envFor('PLACEMENT_PROBE_ENABLED', 'true')),
    ).toBe(true);
  });

  it.each(INPUTS)('env=%s matches the old ==="true" reader', (raw) => {
    const expected = raw === 'true'; // old: raw === 'true' — nothing else
    expect(
      getConfigFlag('PLACEMENT_PROBE_ENABLED', envFor('PLACEMENT_PROBE_ENABLED', raw)),
      `raw=${JSON.stringify(raw)}`,
    ).toBe(expected);
  });

  it('is compose-pinned: DB rows never apply and source reports compose-forced', () => {
    // 注入 DB 行也不应生效（registry envMode='pinned' → DB 层整层跳过）。
    replaceConfigSnapshot({
      epoch: 1,
      entries: new Map([
        ['PLACEMENT_PROBE_ENABLED', { value: true, revision: 1, updatedAt: null }],
      ]),
      hydratedAt: 'x',
    });
    expect(getConfigFlag('PLACEMENT_PROBE_ENABLED', {})).toBe(false);
    const r = resolveConfigValue(
      'PLACEMENT_PROBE_ENABLED',
      envFor('PLACEMENT_PROBE_ENABLED', 'true'),
    );
    expect(r.source).toBe('compose-forced');
  });
});

describe('compose-forced flags — registration + pinned mode', () => {
  // docker-compose.mac.yml 强制的三面旗：PLACEMENT_PROBE_ENABLED /
  // WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED / MISCONCEPTION_PROMOTE_ENABLED。
  // 全部必须 registered + envMode='pinned'（写端 409 / DB 层跳过），否则
  // 面板写会静默输给 deploy pin。
  for (const key of [
    'PLACEMENT_PROBE_ENABLED',
    'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED',
    'MISCONCEPTION_PROMOTE_ENABLED',
  ]) {
    it(`${key} is registered with envMode='pinned'`, () => {
      const def = CONFIG_REGISTRY[key];
      expect(def, `${key} missing from CONFIG_REGISTRY`).toBeDefined();
      expect(def.envMode).toBe('pinned');
      expect(def.envName).toBe(key);
    });
  }

  it.each(INPUTS)('WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED env=%s matches old parseFlag', (raw) => {
    expect(
      getConfigFlag(
        'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED',
        envFor('WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED', raw),
      ),
    ).toBe(oldParseFlag(raw, false));
  });

  it.each(INPUTS)('MISCONCEPTION_PROMOTE_ENABLED env=%s matches old parseFlag', (raw) => {
    expect(
      getConfigFlag('MISCONCEPTION_PROMOTE_ENABLED', envFor('MISCONCEPTION_PROMOTE_ENABLED', raw)),
    ).toBe(oldParseFlag(raw, false));
  });

  // review P1-1：compose 只设置 ENABLED 旗——THRESHOLD 是可调旋钮，必须可写。
  // 误 pin 会让 setConfig 409（阈值变 deploy 死值）。
  it('WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD is NOT pinned (tunable, DB-writable)', () => {
    const def = CONFIG_REGISTRY.WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD;
    expect(def).toBeDefined();
    expect(def?.envMode ?? 'fallback').toBe('fallback');
  });
});

describe('parser drift compat (P2) — env 层逐位回放迁移前语义', () => {
  // ── rate-limit：原 readPositiveInt —— Number(raw)，有限且>0 → floor；其余 fallback。
  function oldReadPositiveInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
  }

  it.each(INPUTS)('AI_RATE_LIMIT_MAX env=%s == old readPositiveInt(.., 30)', (raw) => {
    // '1e2' 旧 → 100（posIntEnv 给 1）；'0' 旧 → 30 fallback（posIntEnv undefined→30，巧合相等）；
    // '1.9' 旧 floor→1。语义等价要求逐值相等。
    const expected = oldReadPositiveInt(raw, 30);
    expect(getConfig('AI_RATE_LIMIT_MAX', envFor('AI_RATE_LIMIT_MAX', raw)), `raw=${raw}`).toBe(
      expected,
    );
  });

  it.each(INPUTS)('AI_RATE_LIMIT_WINDOW_MS env=%s == old readPositiveInt(.., 10000)', (raw) => {
    const expected = oldReadPositiveInt(raw, 10_000);
    expect(
      getConfig('AI_RATE_LIMIT_WINDOW_MS', envFor('AI_RATE_LIMIT_WINDOW_MS', raw)),
      `raw=${raw}`,
    ).toBe(expected);
  });

  // ── judge calibration：原 readIntInRange —— parseInt；NaN→fallback；clamp 在
  // reader 侧（'0' → 0 → clamp→1），故 envParse 必须给出 0（posIntEnv 给 undefined → 20/7）。
  function oldReadIntInRange(
    raw: string | undefined,
    min: number,
    max: number,
    fallback: number,
  ): number {
    const n = Number.parseInt(raw ?? '', 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  it.each(INPUTS)(
    'JUDGE_CALIBRATION_BATCH_MAX env=%s == old readIntInRange(.., 1, 50, 20)',
    (raw) => {
      const expected = oldReadIntInRange(raw, 1, 50, 20);
      // envParse 层输出（未 clamp）；reader 侧 clamp—— 等价性比 envParse 层+reader clamp。
      const parsed = getConfig(
        'JUDGE_CALIBRATION_BATCH_MAX',
        envFor('JUDGE_CALIBRATION_BATCH_MAX', raw),
      );
      const final = typeof parsed === 'number' ? Math.min(50, Math.max(1, parsed)) : 20;
      expect(final, `raw=${raw}`).toBe(expected);
    },
  );

  it.each(INPUTS)(
    'JUDGE_CALIBRATION_WINDOW_DAYS env=%s == old readIntInRange(.., 1, 90, 7)',
    (raw) => {
      const expected = oldReadIntInRange(raw, 1, 90, 7);
      const parsed = getConfig(
        'JUDGE_CALIBRATION_WINDOW_DAYS',
        envFor('JUDGE_CALIBRATION_WINDOW_DAYS', raw),
      );
      const final = typeof parsed === 'number' ? Math.min(90, Math.max(1, parsed)) : 7;
      expect(final, `raw=${raw}`).toBe(expected);
    },
  );

  // ── KC dedup int 键：原 resolvePositiveInt = trunc(Number(raw))，>0 且 trunc>=1，
  // 否则 fallback（'1e2' → 100，不是 parseInt 的 1）。
  function oldResolvePositiveInt(raw: string | undefined, fallback: number): number {
    if (raw == null || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    const v = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    const n = Math.trunc(v);
    return n >= 1 ? n : fallback;
  }

  it.each(INPUTS)('KC_DEDUP_WINDOW_DAYS env=%s == old resolvePositiveInt(.., 7)', (raw) => {
    const expected = oldResolvePositiveInt(raw, 7);
    const parsed = getConfig('KC_DEDUP_WINDOW_DAYS', envFor('KC_DEDUP_WINDOW_DAYS', raw));
    const n = typeof parsed === 'number' ? Math.trunc(parsed) : Number.NaN;
    const final = Number.isFinite(n) && n >= 1 ? n : 7;
    expect(final, `raw=${raw}`).toBe(expected);
  });

  it.each(INPUTS)('KC_DEDUP_MAX_PAIRS env=%s == old resolvePositiveInt(.., 50)', (raw) => {
    const expected = oldResolvePositiveInt(raw, 50);
    const parsed = getConfig('KC_DEDUP_MAX_PAIRS', envFor('KC_DEDUP_MAX_PAIRS', raw));
    const n = typeof parsed === 'number' ? Math.trunc(parsed) : Number.NaN;
    const final = Number.isFinite(n) && n >= 1 ? n : 50;
    expect(final, `raw=${raw}`).toBe(expected);
  });

  // ── jyeoo spawn 组：原 Number.parseInt(env ?? 'default') 直通（NaN 直通给
  // spawn 边界 fail-closed）。'' 不是 unset：旧 parseInt('')=NaN → fail-closed。
  for (const [key, fallback] of [
    ['JYEOO_SPAWN_TIMEOUT_MS', 120_000],
    ['JYEOO_SPAWN_MAX_STDOUT_BYTES', 8 * 1024 * 1024],
    ['JYEOO_SPAWN_MAX_STDERR_BYTES', 1024 * 1024],
  ] as const) {
    it.each(INPUTS)(`${key} env=%s == old parseInt passthrough`, (raw) => {
      const old = raw === undefined ? fallback : Number.parseInt(raw, 10); // NaN 直通
      const resolved = getConfig(key, envFor(key, raw));
      const final = typeof resolved === 'number' ? resolved : fallback;
      if (Number.isNaN(old)) {
        expect(Number.isNaN(final), `raw=${JSON.stringify(raw)} expected NaN got ${final}`).toBe(
          true,
        );
      } else {
        expect(final, `raw=${raw}`).toBe(old);
      }
    });
  }

  // ── BACKFILL 键：原 `env.BACKFILL || env.SPAWN` 链——'' 是 falsy = 未设置
  // （下探 SPAWN 层/推导默认）；非数字 parseInt 直通 NaN。CI 收口（run
  // 36425519241）：rawParseIntEnv 把 '' 变已表达 NaN，撞断 ''→下探语义。
  it.each(INPUTS)('JYEOO_BACKFILL_TIMEOUT_MS env=%s == old falsy-chain semantics', (raw) => {
    const old = raw === undefined || raw.trim() === '' ? undefined : Number.parseInt(raw, 10);
    expect(
      getConfig('JYEOO_BACKFILL_TIMEOUT_MS', envFor('JYEOO_BACKFILL_TIMEOUT_MS', raw)),
      `raw=${JSON.stringify(raw)}`,
    ).toEqual(old);
  });

  // ── enum 键：原文裸比较（无 trim）。' apply '（带空白）旧 → off。
  it.each(INPUTS)('HUB_SYNC_MODE env=%s == old bare-compare semantics', (raw) => {
    const rawStr = raw as string | undefined;
    const old = rawStr === 'apply' || rawStr === 'shadow' ? rawStr : 'off';
    const v = getConfig('HUB_SYNC_MODE', envFor('HUB_SYNC_MODE', raw));
    const final = v === 'apply' || v === 'shadow' ? v : 'off';
    expect(final, `raw=${JSON.stringify(raw)}`).toBe(old);
  });
});

describe('duplicate keyspace (P2) — bare AI_PROVIDER_OVERRIDE/AI_PROVIDER_MODEL must not exist as DB keys', () => {
  // resolver 只消费 lane.global.*；接受裸 key 的 DB 行会静默不生效——撤销注册，
  // 写端（unknown key 400）与 hydrate（unregistered skip）都 fail-loud。
  it('bare AI_PROVIDER_OVERRIDE / AI_PROVIDER_MODEL are NOT registered', () => {
    expect(CONFIG_REGISTRY.AI_PROVIDER_OVERRIDE).toBeUndefined();
    expect(CONFIG_REGISTRY.AI_PROVIDER_MODEL).toBeUndefined();
  });

  it('lane.global.provider keeps env pin > DB (priority mode via AI_PROVIDER_OVERRIDE env)', () => {
    replaceConfigSnapshot({
      epoch: 1,
      entries: new Map([
        ['lane.global.provider', { value: 'db-provider', revision: 1, updatedAt: null }],
      ]),
      hydratedAt: 'x',
    });
    const r = resolveConfigValue('lane.global.provider', {
      AI_PROVIDER_OVERRIDE: 'env-pin',
    } as NodeJS.ProcessEnv);
    expect(r.value).toBe('env-pin');
    expect(r.source).toBe('env');
  });
});
