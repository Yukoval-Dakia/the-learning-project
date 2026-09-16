// YUK-986 (Supply-Agent/1) — 瘦身后的 supply-config 单测。YUK-697 时代的 dg token 映射 /
// kill-switch / profile jyeooSupply 支持判定测试随 queue 形态退役删除；留存面 =
// producer binary 路径解析与 spawn 资源边界 env 读取（jyeoo_fetch_candidates tool 链消费）。
import { afterEach, describe, expect, it } from 'vitest';
import {
  JYEOO_BACKFILL_PER_QUESTION_MS,
  JYEOO_FETCH_ROUTE,
  JYEOO_SOURCE_HOST,
  jyeooBackfillSpawnTimeoutMs,
  jyeooBinaryPath,
  jyeooSpawnMaxStderrBytes,
  jyeooSpawnMaxStdoutBytes,
  jyeooSpawnTimeoutMs,
} from './jyeoo-supply-config';

const ENV_KEYS = [
  'JYEOO_RS_BINARY',
  'JYEOO_SPAWN_TIMEOUT_MS',
  'JYEOO_BACKFILL_TIMEOUT_MS',
  'JYEOO_SPAWN_MAX_STDOUT_BYTES',
  'JYEOO_SPAWN_MAX_STDERR_BYTES',
] as const;

const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('jyeoo-supply-config constants', () => {
  it('keeps the route/host vocabulary stable (provenance + SupplyProducerRoute twin)', () => {
    expect(JYEOO_FETCH_ROUTE).toBe('jyeoo_fetch');
    expect(JYEOO_SOURCE_HOST).toBe('www.jyeoo.com');
  });
});

describe('jyeooBinaryPath', () => {
  it('prefers JYEOO_RS_BINARY when set', () => {
    setEnv('JYEOO_RS_BINARY', '/custom/jyeoo-rs');
    expect(jyeooBinaryPath()).toBe('/custom/jyeoo-rs');
  });

  it('falls back to the repo default release path under HOME', () => {
    setEnv('JYEOO_RS_BINARY', undefined);
    expect(jyeooBinaryPath()).toBe(
      `${process.env.HOME}/yukoval-projects/jyeoo-rs/target/release/jyeoo-rs`,
    );
  });

  it('ignores a blank JYEOO_RS_BINARY', () => {
    setEnv('JYEOO_RS_BINARY', '   ');
    expect(jyeooBinaryPath()).toContain('yukoval-projects/jyeoo-rs');
  });
});

describe('spawn bounds env parsing', () => {
  it('uses defaults when env unset', () => {
    setEnv('JYEOO_SPAWN_TIMEOUT_MS', undefined);
    setEnv('JYEOO_SPAWN_MAX_STDOUT_BYTES', undefined);
    setEnv('JYEOO_SPAWN_MAX_STDERR_BYTES', undefined);
    expect(jyeooSpawnTimeoutMs()).toBe(120000);
    expect(jyeooSpawnMaxStdoutBytes()).toBe(8 * 1024 * 1024);
    expect(jyeooSpawnMaxStderrBytes()).toBe(1024 * 1024);
  });

  it('honours overrides', () => {
    setEnv('JYEOO_SPAWN_TIMEOUT_MS', '5000');
    setEnv('JYEOO_SPAWN_MAX_STDOUT_BYTES', '1024');
    setEnv('JYEOO_SPAWN_MAX_STDERR_BYTES', '2048');
    expect(jyeooSpawnTimeoutMs()).toBe(5000);
    expect(jyeooSpawnMaxStdoutBytes()).toBe(1024);
    expect(jyeooSpawnMaxStderrBytes()).toBe(2048);
  });
});

// YUK-998 — backfill（pnpm jyeoo:backfill）是批量 caller：不吃 in-band 120s 默认
// （grade 路线 ~45s+/题串行，SIGKILL 中途丢整批并白烧付费拉题），而是按批大小自适配，
// 并支持 JYEOO_BACKFILL_TIMEOUT_MS / JYEOO_SPAWN_TIMEOUT_MS 显式覆盖。
describe('jyeooBackfillSpawnTimeoutMs', () => {
  it('defaults scale with session size (90s/question: --max 10 ⇒ 900s verified tier)', () => {
    setEnv('JYEOO_BACKFILL_TIMEOUT_MS', undefined);
    setEnv('JYEOO_SPAWN_TIMEOUT_MS', undefined);
    expect(jyeooBackfillSpawnTimeoutMs(4)).toBe(4 * JYEOO_BACKFILL_PER_QUESTION_MS);
    expect(jyeooBackfillSpawnTimeoutMs(10)).toBe(900_000);
    expect(jyeooBackfillSpawnTimeoutMs(40)).toBe(3_600_000);
  });

  it('JYEOO_BACKFILL_TIMEOUT_MS wins over the scaled default and the shared bound', () => {
    setEnv('JYEOO_BACKFILL_TIMEOUT_MS', '1200000');
    setEnv('JYEOO_SPAWN_TIMEOUT_MS', '45000');
    expect(jyeooBackfillSpawnTimeoutMs(10)).toBe(1_200_000);
  });

  it('honours an explicit JYEOO_SPAWN_TIMEOUT_MS when the backfill env is unset', () => {
    // YUK-989 复验路径：JYEOO_SPAWN_TIMEOUT_MS=900000 pnpm jyeoo:backfill。
    setEnv('JYEOO_BACKFILL_TIMEOUT_MS', undefined);
    setEnv('JYEOO_SPAWN_TIMEOUT_MS', '900000');
    expect(jyeooBackfillSpawnTimeoutMs(10)).toBe(900_000);
  });

  it('treats an empty-string env as unset (falls through to the next tier)', () => {
    setEnv('JYEOO_BACKFILL_TIMEOUT_MS', '');
    setEnv('JYEOO_SPAWN_TIMEOUT_MS', '300000');
    expect(jyeooBackfillSpawnTimeoutMs(10)).toBe(300_000);
  });

  it('passes garbage through as NaN (documented fail-closed: spawn bounds check rejects)', () => {
    // YUK-990 裁决接受：env 侧不纠偏——spawnJyeooFetch 拒绝非正值/非有限 → 'spawn' failure。
    setEnv('JYEOO_BACKFILL_TIMEOUT_MS', 'soon');
    expect(jyeooBackfillSpawnTimeoutMs(10)).toBeNaN();
  });
});
