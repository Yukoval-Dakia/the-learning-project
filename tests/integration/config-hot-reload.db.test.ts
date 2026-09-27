/**
 * YUK-1007 — config hydrate + write db 测试。
 *
 * 跑 db 车道（需要 testDb + migration 已建的三表）。验证：
 *   - hydrateConfigFromDb 把 system_config 行装进同步快照，坏行/未登记/pinned 行
 *     各自 skip 而不拖垮整轮；
 *   - setConfig 在同一 tx 写行 + journal + epoch bump，commit 后即时 hydrate
 *     （本进程 0 延迟）；
 *   - clearConfig 删行 + 留 clear journal，回到 env/code floor；
 *   - epoch 探测同号时跳全量 SELECT（epochUnchanged=true）。
 *
 * 隔离：beforeEach resetDb（config 三表已列入 wipe list，RESTART IDENTITY 清
 * change_seq），afterEach resetTestConfig + 快照复位，保证 reader 测试互不泄漏。
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getConfig,
  getConfigSnapshotEpoch,
  replaceConfigSnapshot,
  resetTestConfig,
} from '@/core/config/store';
import { system_config, system_config_epoch, system_config_journal } from '@/db/schema';
import { hydrateConfigFromDb } from '@/server/config/hydrate';
import { clearConfig, setConfig } from '@/server/config/write';

import { resetDb, testDb } from '../helpers/db';

const EMPTY_SNAPSHOT = { epoch: 0, entries: new Map(), hydratedAt: '' };

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  resetTestConfig();
  replaceConfigSnapshot(EMPTY_SNAPSHOT);
});

describe('hydrateConfigFromDb', () => {
  it('loads registered rows into the sync snapshot; getConfig sees db source', async () => {
    const db = testDb();
    await db.insert(system_config).values({
      key: 'JYEOO_DAILY_FETCH_BUDGET',
      value: 27,
      revision: 1,
      updated_by: 'cli',
      created_at: new Date(),
      updated_at: new Date(),
    });

    const report = await hydrateConfigFromDb(db);
    expect(report.hydrated).toContain('JYEOO_DAILY_FETCH_BUDGET');
    expect(report.epochUnchanged).toBe(false);

    // env absent → DB row wins over codeDefault 40.
    expect(getConfig('JYEOO_DAILY_FETCH_BUDGET', {})).toBe(27);
  });

  it('skips unregistered / schema-failed rows without failing the round', async () => {
    const db = testDb();
    await db.insert(system_config).values([
      {
        key: 'TOTALLY_UNREGISTERED_KEY',
        value: 'x',
        revision: 1,
        updated_by: 'cli',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        key: 'JYEOO_DAILY_FETCH_BUDGET',
        value: 'not-a-number', // fails z.number()
        revision: 1,
        updated_by: 'cli',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        key: 'AI_RATE_LIMIT_MAX', // good row alongside the bad ones
        value: 99,
        revision: 1,
        updated_by: 'cli',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    const report = await hydrateConfigFromDb(db);
    expect(report.hydrated).toContain('AI_RATE_LIMIT_MAX');
    expect(report.skipped.map((s) => s.key)).toEqual(
      expect.arrayContaining(['TOTALLY_UNREGISTERED_KEY', 'JYEOO_DAILY_FETCH_BUDGET']),
    );
    // good row still applied; bad rows fell to floor
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(99);
  });

  it('epoch-unchanged probe skips the full SELECT', async () => {
    const db = testDb();
    await db.insert(system_config_epoch).values({
      id: 'global',
      epoch: 5,
      updated_at: new Date(),
    });
    // first hydrate adopts epoch 5
    const r1 = await hydrateConfigFromDb(db);
    expect(r1.epoch).toBe(5);
    // second hydrate: epoch probe matches → epochUnchanged
    const r2 = await hydrateConfigFromDb(db);
    expect(r2.epochUnchanged).toBe(true);
    expect(r2.epoch).toBe(5);
  });
});

describe('setConfig / clearConfig', () => {
  it('writes row + journal + bumps epoch in one tx and hydrates immediately', async () => {
    const db = testDb();
    const before = getConfigSnapshotEpoch();

    const res = await setConfig('AI_RATE_LIMIT_MAX', 123, { actor: 'cli' }, db);
    expect(res.key).toBe('AI_RATE_LIMIT_MAX');
    expect(res.revision).toBe(1);
    expect(res.epoch).toBeGreaterThan(before);

    // immediate hydrate: reader sees the new value synchronously
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(123);

    const rows = await db.select().from(system_config);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(123);

    const journal = await db.select().from(system_config_journal);
    expect(journal).toHaveLength(1);
    expect(journal[0].action).toBe('set');
    expect(journal[0].actor).toBe('cli');
    expect((journal[0].payload as { next: unknown }).next).toBe(123);
  });

  it('increments per-key revision on rewrite', async () => {
    const db = testDb();
    await setConfig('AI_RATE_LIMIT_MAX', 10, { actor: 'cli' }, db);
    const res = await setConfig('AI_RATE_LIMIT_MAX', 20, { actor: 'cli' }, db);
    expect(res.revision).toBe(2);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(20);
    expect((await db.select().from(system_config_journal)).length).toBe(2);
  });

  it('rejects unregistered key (400) and schema-bad value (422)', async () => {
    const db = testDb();
    await expect(
      setConfig('NO_SUCH_KEY_XYZ', 'v', { actor: 'cli' }, db),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      setConfig('JYEOO_DAILY_FETCH_BUDGET', 'abc', { actor: 'cli' }, db),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects a compose-pinned key with 409', async () => {
    const db = testDb();
    // A pinned key from the registry — envMode='pinned'. Pick one that exists.
    // AI_PROVIDER_OVERRIDE is 'priority', not pinned. Use a known pinned compose
    // key — assert via the ApiError status contract regardless of which key.
    // JYEOO_RS_BINARY is compose-forced in this lane.
    await expect(
      setConfig('JYEOO_RS_BINARY', '/tmp/x', { actor: 'cli' }, db),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('clearConfig deletes the row and returns to floor, leaving a clear journal', async () => {
    const db = testDb();
    await setConfig('AI_RATE_LIMIT_MAX', 55, { actor: 'cli' }, db);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(55);

    const res = await clearConfig('AI_RATE_LIMIT_MAX', { actor: 'cli' }, db);
    expect(res.cleared).toBe(true);

    // row gone → floor (codeDefault) restored
    const rows = await db.select().from(system_config);
    expect(rows).toHaveLength(0);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).not.toBe(55);

    const journal = await db.select().from(system_config_journal);
    expect(journal.map((j) => j.action)).toEqual(['set', 'clear']);
  });
});

describe('Tier A reader goes live — judgeDurableEnabled()', () => {
  // 现场证明一条 Tier A reader 从 env 静态读切到热加载面：setConfig 写 DB →
  // 同进程即时生效（0 延迟 hydrate），clearConfig → 回 code-default。
  it('off by default, on after setConfig(true), off again after clearConfig', async () => {
    const db = testDb();
    const { judgeDurableEnabled } = await import(
      '@/capabilities/practice/server/judge-durable-config'
    );

    expect(judgeDurableEnabled()).toBe(false); // codeDefault

    await setConfig('JUDGE_DURABLE_ENABLED', true, { actor: 'cli' }, db);
    expect(judgeDurableEnabled()).toBe(true); // DB row beats default, live

    await clearConfig('JUDGE_DURABLE_ENABLED', { actor: 'cli' }, db);
    expect(judgeDurableEnabled()).toBe(false); // back to floor
  });
});
