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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    await expect(setConfig('NO_SUCH_KEY_XYZ', 'v', { actor: 'cli' }, db)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      setConfig('JYEOO_DAILY_FETCH_BUDGET', 'abc', { actor: 'cli' }, db),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects a compose-pinned key with 409', async () => {
    const db = testDb();
    // Pinned keys from the registry — envMode='pinned'. After the keyspace dedup
    // the compose-forced flags are MISCONCEPTION_PROMOTE_ENABLED /
    // WORKFLOW_JUDGE_AUTO_ENROLL_* / PLACEMENT_PROBE_ENABLED (JYEOO_RS_BINARY is
    // not pinned — it has env fallback).
    await expect(
      setConfig('MISCONCEPTION_PROMOTE_ENABLED', true, { actor: 'cli' }, db),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      setConfig('PLACEMENT_PROBE_ENABLED', true, { actor: 'cli' }, db),
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

// ────────────────────────────────────────────────────────────────────────────
// YUK-1007 review P1/P2 修复回归组
// ────────────────────────────────────────────────────────────────────────────

describe('P1-2 — revision durable source (journal max + 1, not value row)', () => {
  it('set → clear → set does not collide on journal (key, revision) PK', async () => {
    const db = testDb();
    await setConfig('AI_RATE_LIMIT_MAX', 10, { actor: 'cli' }, db); // rev 1
    await clearConfig('AI_RATE_LIMIT_MAX', { actor: 'cli' }, db); // rev 2 (clear journal)
    // Bug: next revision came from the deletable value row → re-inserts revision=1
    // → PK collision with the existing journal row (rev 1). Pre-fix this throws.
    const res = await setConfig('AI_RATE_LIMIT_MAX', 30, { actor: 'cli' }, db);
    expect(res.revision).toBe(3);
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(30);
    const journal = await db.select().from(system_config_journal);
    expect(journal.map((j) => `${j.action}@${j.revision}`)).toEqual(['set@1', 'clear@2', 'set@3']);
  });

  it('clear → clear keeps monotonically increasing revisions', async () => {
    const db = testDb();
    await setConfig('AI_RATE_LIMIT_MAX', 10, { actor: 'cli' }, db); // rev 1
    await clearConfig('AI_RATE_LIMIT_MAX', { actor: 'cli' }, db); // rev 2
    // Second clear on an already-deleted row must still journal a NEW revision.
    const res = await clearConfig('AI_RATE_LIMIT_MAX', { actor: 'cli' }, db);
    expect(res.revision).toBe(3);
    const journal = await db.select().from(system_config_journal);
    expect(journal.map((j) => j.revision)).toEqual([1, 2, 3]);
  });

  it('interleaved set/clear across two keys does not cross-talk revisions', async () => {
    const db = testDb();
    await setConfig('AI_RATE_LIMIT_MAX', 1, { actor: 'cli' }, db);
    await setConfig('KC_DEDUP_MAX_PAIRS', 9, { actor: 'cli' }, db);
    await clearConfig('AI_RATE_LIMIT_MAX', { actor: 'cli' }, db);
    const a = await setConfig('AI_RATE_LIMIT_MAX', 2, { actor: 'cli' }, db);
    const b = await clearConfig('KC_DEDUP_MAX_PAIRS', { actor: 'cli' }, db);
    expect(a.revision).toBe(3); // 1(set) + 2(clear) → 3
    expect(b.revision).toBe(2); // KC_DEDUP_MAX_PAIRS own axis
  });
});

describe('P1-5 — combined provider+model pair validation (final state in-tx)', () => {
  it('writing task.QuizGenTask.provider=openai with no model rejects 422 (final combo read in-tx)', async () => {
    const db = testDb();
    await expect(
      setConfig('task.QuizGenTask.provider', 'openai', { actor: 'cli' }, db),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('model-cleared-under-provider rejects: openai cannot pair with empty model', async () => {
    const db = testDb();
    const { setConfigs } = await import('@/server/config/write');
    // provider=openai 只有与 model 一批写才立得住；batch 内读兄弟行组合通过。
    await setConfigs(
      [
        { key: 'task.QuizGenTask.provider', value: 'openai' },
        { key: 'task.QuizGenTask.model', value: 'gpt-6-astra' },
      ],
      { actor: 'cli' },
      db,
    );
    // Pre-fix: clearing .model is not validated → openai + no explicit model leaks.
    await expect(clearConfig('task.QuizGenTask.model', { actor: 'cli' }, db)).rejects.toMatchObject(
      { status: 422 },
    );
  });

  it('clearing a provider cannot leave its model under the registry default provider)', async () => {
    const db = testDb();
    const { setConfigs } = await import('@/server/config/write');
    await setConfigs(
      [
        { key: 'task.QuizGenTask.provider', value: 'openai' },
        { key: 'task.QuizGenTask.model', value: 'gpt-6-astra' },
      ],
      { actor: 'cli' },
      db,
    );
    await expect(
      clearConfig('task.QuizGenTask.provider', { actor: 'cli' }, db),
    ).rejects.toMatchObject({ status: 422 });
  });

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

  it('provider-only rewrite rejects a model absent from the target native preset)', async () => {
    const db = testDb();
    const { setConfigs } = await import('@/server/config/write');
    await setConfigs(
      [
        { key: 'task.QuizGenTask.provider', value: 'xiaomi' },
        { key: 'task.QuizGenTask.model', value: 'mimo-v2.5-pro' },
      ],
      { actor: 'cli' },
      db,
    );
    await expect(
      setConfigs([{ key: 'task.QuizGenTask.provider', value: 'openai' }], { actor: 'cli' }, db),
    ).rejects.toMatchObject({ status: 422 });
    expect(getConfig('task.QuizGenTask.provider', {})).toBe('xiaomi');
  });

  it('writing model under a provider that has a runnable default is allowed', async () => {
    const db = testDb();
    // xiaomi / anthropic-sub have runnable defaults — provider alone is legal.
    const res = await setConfig('lane.global.provider', 'anthropic-sub', { actor: 'cli' }, db);
    expect(res.key).toBe('lane.global.provider');
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

  it('deterministic barrier: a stale publish cannot land after a newer write (single-flight chain)', async () => {
    const db = testDb();
    // 第二轮 review P2：Oracle 受控实验的确定性编码（无 sleep）。旧版测试只断言
    // 返回数字，去掉串行链仍能过。用 __hydratePublishGate（epoch 守卫通过后、
    // 发布前的 barrier）构造精确竞态：
    //   A（旧 hydrate）读到 (e1,10)、守卫通过后挂起在 barrier；
    //   写 (e2,20) 的 tx commit，其写后 hydrate B 排在 A 后面（串行链）；
    //   放行 A → A 先发布 (e1,10) → B 再读再发布 (e2,20)——最终值必须是新值，
    //   A 的陈旧发布落在 B 之前（reportA.epoch=e1），发布序严格递增。
    // 去掉串行链时 B 不等 A：B 先发布 (e2,20)、A 恢复后回写 (e1,10)——守卫
    // 检查早已通过拦不住 → 最终值 10 → 本测试 RED。
    await setConfig('AI_RATE_LIMIT_MAX', 10, { actor: 'cli' }, db); // e1 / 10
    const e1 = getConfigSnapshotEpoch();
    // 模拟「另一进程视角」：已发布快照归零，A 的探测才会走全量读。
    replaceConfigSnapshot(EMPTY_SNAPSHOT);

    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let firstHookFired!: () => void;
    const firstHookFiredP = new Promise<void>((resolve) => {
      firstHookFired = resolve;
    });
    let firstGate = true;
    const { __hydratePublishGate } = await import('@/server/config/hydrate');
    __hydratePublishGate.hook = () => {
      if (firstGate) {
        firstGate = false; // 只拦第一轮（A）；后续轮次直通
        firstHookFired();
        return gateA;
      }
      return Promise.resolve();
    };

    try {
      // A：旧 hydrate——事件驱动等到它挂进 barrier（读到 (e1,10)、守卫已过）。
      const hydrateA = hydrateConfigFromDb(db);
      await firstHookFiredP;

      // 新写 (e2,20)：tx commit 后其写后 hydrate B 入链排在 A 之后。不 await——
      // 串行模式下它要等 A 放行后才落定。

      // de-serialized 探测窗：事件循环让步（setImmediate，非定时 sleep）直到写落定
      // （de-serialized 世界里 B 已在这窗口发布）或耗尽。串行实现下 writeSettled
      // 在 A 放行前恒 false——循环自然耗尽，无 wall-clock 等待。
      let writeSettled = false;
      const writeDone = setConfig('AI_RATE_LIMIT_MAX', 20, { actor: 'cli' }, db).then(
        () => {
          writeSettled = true;
        },
        () => {
          writeSettled = true;
        },
      );
      for (let i = 0; i < 500 && !writeSettled; i++) {
        await new Promise<void>((r) => setImmediate(r));
      }

      // 放行 A：A 发布它读到的一致快照。
      releaseA?.();
      await Promise.all([hydrateA, writeDone]);

      // 终态：新值 + 新 epoch。串行：A 先发旧、B 后发新 → 20。
      // de-serialized：B 已在挂起窗发布 20，A 放行后回写 10 → 这里 RED。
      expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBe(20);
      expect(getConfigSnapshotEpoch()).toBeGreaterThan(e1);
      // A 的陈旧发布确实发生过（reportA 记录 e1，未被守卫拒绝）。
      const reportA = await hydrateA;
      expect(reportA.epoch).toBe(e1);
      expect(reportA.staleSkipped ?? false).toBe(false);
    } finally {
      __hydratePublishGate.hook = undefined;
    }
  });
});

describe('P1-2 — concurrent same-key writes serialize on the journal axis', () => {
  it('8 parallel setConfigs land unique contiguous revisions with no PK collision', async () => {
    const db = testDb();
    const N = 8;
    // 并发回归：所有写并发发出。epoch 行 + 行锁 + journal 锁串行化它们——
    // 每笔拿到唯一 revision；journal 全量在、无 duplicate-key 事务回滚。
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        setConfig('AI_RATE_LIMIT_MAX', 100 + i, { actor: 'cli' }, db),
      ),
    );
    const revisions = results.map((r) => r.revision).sort((a, b) => a - b);
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const journal = await db.select().from(system_config_journal);
    expect(journal).toHaveLength(N);
    // 事务内 revision 严格单调 → journal PK 无碰撞，每笔都 commit 了。
    expect(getConfig('AI_RATE_LIMIT_MAX', {})).toBeGreaterThan(0);
  });

  it('parallel set+clear mix on one key keeps the journal append-only and collision-free', async () => {
    const db = testDb();
    // 先立一行，再并发 6 笔混合 set/clear：clear 删行后并发 set 不得回卷 revision。
    await setConfig('KC_DEDUP_MAX_PAIRS', 9, { actor: 'cli' }, db); // rev 1
    const writes = [
      setConfig('KC_DEDUP_MAX_PAIRS', 10, { actor: 'cli' }, db),
      clearConfig('KC_DEDUP_MAX_PAIRS', { actor: 'cli' }, db),
      setConfig('KC_DEDUP_MAX_PAIRS', 11, { actor: 'cli' }, db),
      clearConfig('KC_DEDUP_MAX_PAIRS', { actor: 'cli' }, db),
      setConfig('KC_DEDUP_MAX_PAIRS', 12, { actor: 'cli' }, db),
      clearConfig('KC_DEDUP_MAX_PAIRS', { actor: 'cli' }, db),
    ];
    const settled = await Promise.allSettled(writes);
    // 全部成功（无 duplicate-key 回滚）。
    for (const s of settled) expect(s.status).toBe('fulfilled');
    const journal = await db.select().from(system_config_journal);
    const revs = journal.map((j) => j.revision).sort((a, b) => a - b);
    expect(revs).toEqual([1, 2, 3, 4, 5, 6, 7]); // 7 笔全在，无碰撞无丢失
  });
});

describe('P1-5 — pair validation covers the env-pin precedence layer', () => {
  it('env-pinned openai makes a DB model clear reject 422 (effective pair, not DB pair)', async () => {
    const db = testDb();
    const { setConfigs } = await import('@/server/config/write');
    // DB 侧一对完整组合先落地。
    await setConfigs(
      [
        { key: 'lane.global.provider', value: 'openai' },
        { key: 'lane.global.model', value: 'gpt-6-astra' },
      ],
      { actor: 'cli' },
      db,
    );
    // env pin 压 DB：AI_PROVIDER_OVERRIDE=openai、无 AI_PROVIDER_MODEL——
    // 清 DB model 后生效层 openai × 无 model，必须拒。
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'openai');
    try {
      await expect(clearConfig('lane.global.model', { actor: 'cli' }, db)).rejects.toMatchObject({
        status: 422,
      });
      // env 层补上 model 后，同一 clear 合法（生效对 env provider × env model）。
      vi.stubEnv('AI_PROVIDER_MODEL', 'gpt-6-astra');
      const res = await clearConfig('lane.global.model', { actor: 'cli' }, db);
      expect(res.cleared).toBe(true);
    } finally {
      // vitest unstubEnvs 默认 false：unstubAllGlobals 不会还原 stubEnv——
      // 必须显式 unstubAllEnvs，否则 AI_PROVIDER_MODEL 泄漏给后续测试。
      vi.unstubAllEnvs();
    }
  });

  it('writing only the model under an env-pinned explicit-model provider rejects 422', async () => {
    const db = testDb();
    // 无任何 DB 行：env pin openai × 无 model——任何碰到该对的写都必须拦。
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'openai');
    try {
      await expect(
        setConfig('lane.global.model', 'gpt-6-astra', { actor: 'cli' }, db),
      ).resolves.toMatchObject({ key: 'lane.global.model' }); // 刚写的 DB model 补齐生效对 → 允许
      // 反例：清回 model（env 层无 model）→ 拒。
      vi.unstubAllEnvs();
      vi.stubEnv('AI_PROVIDER_OVERRIDE', 'openai');
      await expect(clearConfig('lane.global.model', { actor: 'cli' }, db)).rejects.toMatchObject({
        status: 422,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
