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

import { getConfig, replaceConfigSnapshot, resetTestConfig } from '@/core/config/store';
import { hydrateConfigFromDb } from '@/server/config/hydrate';
import { setConfig } from '@/server/config/write';

import { resetDb, testDb } from '../helpers/db';

const EMPTY_SNAPSHOT = { epoch: 0, entries: new Map(), hydratedAt: '' };

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  resetTestConfig();
  replaceConfigSnapshot(EMPTY_SNAPSHOT);
});

describe('P1-5 — combined provider+model pair validation (final state in-tx)', () => {
  it('batch set provider+model together validates the final combo atomically', async () => {
    const db = testDb();
    const { setConfigs } = await import('@/server/config/write');
    const res = await setConfigs(
      [
        { key: 'lane.global.provider', value: 'openai' },
        { key: 'lane.global.model', value: 'gpt-6-astra' },
      ],
      { actor: 'cli' },
      db,
    );
    expect(res.map((r) => r.key)).toEqual(['lane.global.provider', 'lane.global.model']);
    expect(getConfig('lane.global.provider', {})).toBe('openai');
    expect(getConfig('lane.global.model', {})).toBe('gpt-6-astra');
  });
});

describe('P1-3 — hydrate single-flight + epoch guard', () => {
  it('concurrent hydrates serialize; a stale snapshot cannot overwrite a newer one', async () => {
    const db = testDb();
    // seed epoch=1 val=10
    await setConfig('AI_RATE_LIMIT_MAX', 10, { actor: 'cli' }, db);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(10);

    // Simulate the oracle race: an old-epoch read racing a newer write.
    // With serialization + the epoch guard, the serialized second hydrate cannot
    // republish epoch≤published; craft it by hand: write a stale-row view with
    // a LOWER epoch than the journal axis (mimics a restore-to-old backup), then
    // call hydrate — the epoch guard must refuse to publish the stale read.
    await db.execute(
      sql`update system_config set value = '5'::jsonb where key = 'AI_RATE_LIMIT_MAX'`,
    );
    await db.execute(sql`update system_config_epoch set epoch = 1 where id = 'global'`);
    // published epoch is already > 1 in-process after the set above? Snapshot epoch
    // after setConfig is the bump epoch (≥2). Reading a stale-epoch row now must
    // be refused.
    const rep = await hydrateConfigFromDb(db);
    expect(rep.staleSkipped).toBe(true);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(10); // untouched
  });
});
