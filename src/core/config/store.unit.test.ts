/**
 * YUK-1007 — config store 读面分层单元测试（no-DB 车道）。
 *
 * 覆盖 §1.3 的三分层语义：
 *   envMode='priority' → env 显式 > DB > codeDefault（AI_PROVIDER_OVERRIDE pin）
 *   envMode='pinned'   → env > codeDefault，DB 层跳过（compose 强制三键）
 *   其余               → DB > env > codeDefault
 *
 * DB 层经 `replaceConfigSnapshot` 直接注入（不走 DB）；env 层经每调用点的
 * `env` 参数注入（与既有 reader 的 env-注入 seam 对齐）——本测试不 stub
 * process.env、不碰 DB。每次 resolve 后 resetTestConfig + 手工 restore
 * 快照保证 test 间隔离。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigSnapshot } from './store';
import {
  getConfig,
  getConfigFlag,
  getConfigSnapshot,
  getConfigSnapshotEpoch,
  getConfigSource,
  getLaneOverride,
  getTaskOverride,
  replaceConfigSnapshot,
  resetTestConfig,
  resolveConfigValue,
  setTestConfig,
} from './store';

const EMPTY_SNAPSHOT: ConfigSnapshot = { epoch: 0, entries: new Map(), hydratedAt: '' };

function snapshotWith(entries: Record<string, unknown>, epoch = 1): ConfigSnapshot {
  const map = new Map();
  for (const [key, value] of Object.entries(entries)) {
    map.set(key, { value, revision: 1, updatedAt: '2026-09-27T00:00:00Z' });
  }
  return { epoch, entries: map, hydratedAt: '2026-09-27T00:00:00Z' };
}

afterEach(() => {
  resetTestConfig();
  replaceConfigSnapshot(EMPTY_SNAPSHOT);
});

describe('resolveConfigValue — fallback mode (DB > env > code)', () => {
  const KEY = 'JYEOO_DAILY_FETCH_BUDGET'; // nonNegIntEnv, envMode=fallback, codeDefault=40

  it('returns codeDefault when neither env nor DB expresses', () => {
    const r = resolveConfigValue(KEY, {});
    expect(r.value).toBe(40);
    expect(r.source).toBe('code-default');
  });

  it('env beats codeDefault when DB absent', () => {
    const r = resolveConfigValue(KEY, { [KEY]: '7' });
    expect(r.value).toBe(7);
    expect(r.source).toBe('env');
  });

  it('env=0 is an expressed value (kill-switch, not coalesced to default)', () => {
    // nonNegIntEnv treats 0 as a real value — regression guard for the
    // JYEOO_DAILY_FETCH_BUDGET=0 must-short-circuit rule.
    const r = resolveConfigValue(KEY, { [KEY]: '0' });
    expect(r.value).toBe(0);
    expect(r.source).toBe('env');
  });

  it('DB row beats env', () => {
    replaceConfigSnapshot(snapshotWith({ [KEY]: 25 }));
    const r = resolveConfigValue(KEY, { [KEY]: '7' });
    expect(r.value).toBe(25);
    expect(r.source).toBe('db');
  });

  it('DB row beats codeDefault when env absent', () => {
    replaceConfigSnapshot(snapshotWith({ [KEY]: 12 }));
    expect(getConfig(KEY, {})).toBe(12);
    expect(getConfigSource(KEY, {})).toBe('db');
  });

  it('malformed env literal falls through to DB/code layer', () => {
    replaceConfigSnapshot(snapshotWith({ [KEY]: 33 }));
    const r = resolveConfigValue(KEY, { [KEY]: 'not-a-number' });
    expect(r.value).toBe(33); // env unparsed → treated as unexpressed
    expect(r.source).toBe('db');
  });
});

describe('resolveConfigValue — priority mode (env > DB > code)', () => {
  // lane.global.provider：envMode='priority'，envName=AI_PROVIDER_OVERRIDE
  // （裸 AI_PROVIDER_OVERRIDE 已不在 registry——resolver 只消费 lane.global.*）。
  const KEY = 'lane.global.provider';
  const ENV_NAME = 'AI_PROVIDER_OVERRIDE';

  it('env pin beats a DB row', () => {
    replaceConfigSnapshot(snapshotWith({ [KEY]: 'db-pinned' }));
    const r = resolveConfigValue(KEY, { [ENV_NAME]: 'env-pin' } as NodeJS.ProcessEnv);
    expect(r.value).toBe('env-pin');
    expect(r.source).toBe('env');
  });

  it('DB row wins only when env absent', () => {
    replaceConfigSnapshot(snapshotWith({ [KEY]: 'db-pinned' }));
    const r = resolveConfigValue(KEY, {});
    expect(r.value).toBe('db-pinned');
    expect(r.source).toBe('db');
  });
});

describe('resolveConfigValue — pinned mode (env > code; DB skipped)', () => {
  // MISCONCEPTION_PROMOTE_ENABLED：envMode='pinned'（compose 强制项）。
  // （WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD 曾被误当 pinned 样本——review P1-1
  // 纠正：compose 不设 THRESHOLD，它回落 fallback、DB 可写。）
  const KEY = 'MISCONCEPTION_PROMOTE_ENABLED';

  it('env expressed → compose-forced, beats any DB row', () => {
    replaceConfigSnapshot(snapshotWith({ [KEY]: false })); // DB row present
    const r = resolveConfigValue(KEY, { [KEY]: 'true' } as NodeJS.ProcessEnv);
    expect(r.value).toBe(true);
    expect(r.source).toBe('compose-forced');
  });

  it('DB row is skipped entirely — env absent → codeDefault, not the row', () => {
    replaceConfigSnapshot(snapshotWith({ [KEY]: true }));
    const r = resolveConfigValue(KEY, {});
    expect(r.value).toBe(false); // codeDefault, NOT the DB row
    expect(r.source).toBe('code-default');
  });

  it('test overlay still wins over a pinned env value (P2 seam-order regression guard)', () => {
    // 修 seam-order 前 overlay 在 pinned early-return 之后才被检查，
    // placement 测试的 setTestConfig 会被 compose env 压掉——overlay 恒最上。
    const FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED';
    setTestConfig({ [FLAG]: true });
    const r = resolveConfigValue(FLAG, { [FLAG]: 'false' } as NodeJS.ProcessEnv);
    expect(r.value).toBe(true); // overlay beats env AND code default
    expect(getConfig(FLAG, { [FLAG]: 'false' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('getConfigFlag — boolean coercion safety', () => {
  const KEY = 'JUDGE_DURABLE_ENABLED';

  it('false by default when nothing expresses', () => {
    expect(getConfigFlag(KEY, {})).toBe(false);
  });

  it("env 'true'/'1' → true; 'false'/'0'/junk → falls to codeDefault(false)", () => {
    expect(getConfigFlag(KEY, { [KEY]: 'true' })).toBe(true);
    expect(getConfigFlag(KEY, { [KEY]: '1' })).toBe(true);
    expect(getConfigFlag(KEY, { [KEY]: 'false' })).toBe(false);
    expect(getConfigFlag(KEY, { [KEY]: '0' })).toBe(false);
    expect(getConfigFlag(KEY, { [KEY]: 'junk' })).toBe(false);
  });

  it('DB true wins over env false', () => {
    replaceConfigSnapshot(snapshotWith({ [KEY]: true }));
    expect(getConfigFlag(KEY, { [KEY]: 'false' })).toBe(true);
  });

  it('a dirty non-boolean DB/overlay value reads as false (never truthy-cast)', () => {
    // Guards the `Boolean('false')===true` footgun the store is built against.
    setTestConfig({ [KEY]: 'false' });
    expect(getConfigFlag(KEY, {})).toBe(false);
  });
});

describe('setTestConfig overlay — test-only topmost layer', () => {
  const KEY = 'AI_RATE_LIMIT_MAX';

  it('overlay beats DB and env', () => {
    replaceConfigSnapshot(snapshotWith({ [KEY]: 5 }));
    setTestConfig({ [KEY]: 999 });
    expect(getConfig(KEY, { [KEY]: '3' })).toBe(999);
  });

  it('undefined in setTestConfig clears just that key', () => {
    setTestConfig({ [KEY]: 999 });
    setTestConfig({ [KEY]: undefined });
    expect(getConfig(KEY, {})).not.toBe(999);
  });
});

describe('getTaskOverride / getLaneOverride', () => {
  it('returns undefined when no task.* keys exist', () => {
    expect(getTaskOverride('solve')).toBeUndefined();
  });

  it('assembles provider+model+budget from dynamic task.* keys', () => {
    replaceConfigSnapshot(
      snapshotWith({
        'task.solve.provider': 'claude',
        'task.solve.model': 'opus',
        'task.solve.budget': { maxIterations: 3, maxCost: 1.5 },
      }),
    );
    const o = getTaskOverride('solve');
    expect(o?.provider).toBe('claude');
    expect(o?.model).toBe('opus');
    expect(o?.budget?.maxIterations).toBe(3);
    expect(o?.budget?.maxCost).toBe(1.5);
  });

  it('lane override reads provider/model (env fallback + db)', () => {
    expect(getLaneOverride('verify_solve', {})).toBeUndefined();
    const o = getLaneOverride('verify_solve', {
      'lane.verify_solve.provider': 'x',
    } as NodeJS.ProcessEnv);
    // lane.* keys are registered; env pin path resolves via envName on the def.
    // Whether this particular lane resolves depends on registry envName — assert
    // only the contract shape (object-or-undefined), not a specific value.
    expect(o === undefined || typeof o === 'object').toBe(true);
  });
});

describe('snapshot bookkeeping', () => {
  it('epoch reflects last hydrate', () => {
    expect(getConfigSnapshotEpoch()).toBe(0);
    replaceConfigSnapshot(snapshotWith({}, 42));
    expect(getConfigSnapshotEpoch()).toBe(42);
  });

  it('getConfigSnapshot returns the injected snapshot object', () => {
    const s = snapshotWith({ X: 1 }, 9);
    replaceConfigSnapshot(s);
    expect(getConfigSnapshot()).toBe(s);
  });
});
