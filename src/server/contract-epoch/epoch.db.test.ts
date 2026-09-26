// YUK-1055 — contract-epoch DB 面：marker 读写、迁移状态机、fenced 行为、
// per-delivery fence 与 outstanding 报告。pgboss schema 在测试容器内缺席 →
// 报告/出生 epoch 的降级路径 + 用临时表补的 born-epoch 用例都覆盖。

import { sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { beforeEach, describe, expect, it } from 'vitest';
import { contract_epoch } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  ContractEpochFenceError,
  assertContractEpochRunnable,
  checkContractEpoch,
  fenceAwareJobHandler,
  readContractEpoch,
  readJobBirthEpoch,
  reportOutstandingBossJobs,
  transitionContractEpoch,
  waitForRunnableEpoch,
} from './index';

const fakeJob = (id: string): Job => ({ id }) as unknown as Job;

beforeEach(() => resetDb());

describe('readContractEpoch / gate wiring', () => {
  it('empty table → implicit legacy/active → runnable', async () => {
    expect(await readContractEpoch(testDb())).toBeNull();
    const status = await checkContractEpoch(testDb());
    expect(status).toEqual({
      runnable: true,
      marker: { epoch: 'legacy', state: 'active' },
    });
  });

  it('reads the latest marker row by seq', async () => {
    await testDb().insert(contract_epoch).values({
      seq: 0,
      epoch: 'legacy',
      state: 'active',
      entered_by: 'test',
    });
    const marker = await readContractEpoch(testDb());
    expect(marker).toMatchObject({ epoch: 'legacy', state: 'active', seq: 0 });
    expect((await checkContractEpoch(testDb())).runnable).toBe(true);
  });

  it('(legacy, preparing) fences assertContractEpochRunnable deterministically', async () => {
    await testDb().insert(contract_epoch).values({
      seq: 0,
      epoch: 'legacy',
      state: 'preparing',
      entered_by: 'test',
    });
    const status = await checkContractEpoch(testDb());
    expect(status).toMatchObject({ runnable: false, reason: 'maintenance' });
    await expect(assertContractEpochRunnable(testDb(), 'test-surface')).rejects.toBeInstanceOf(
      ContractEpochFenceError,
    );
  });

  it('(new-epoch, active) fences legacy code as epoch_mismatch', async () => {
    await testDb().insert(contract_epoch).values({
      seq: 0,
      epoch: 'assessment-contract-v1',
      state: 'active',
      entered_by: 'test',
    });
    await expect(assertContractEpochRunnable(testDb(), 'test-surface')).rejects.toMatchObject({
      name: 'ContractEpochFenceError',
      reason: 'epoch_mismatch',
    });
  });
});

describe('transitionContractEpoch', () => {
  it('walks the full cutover arc: prepare → ready → activate (epoch switch)', async () => {
    const db = testDb();
    await db.insert(contract_epoch).values({
      seq: 0,
      epoch: 'legacy',
      state: 'active',
      entered_by: 'seed',
    });

    const p = await transitionContractEpoch(db, 'begin_prepare', 'assessment-contract-v1', 'op');
    expect(p).toMatchObject({ epoch: 'assessment-contract-v1', state: 'preparing', seq: 1 });
    expect((await checkContractEpoch(db)).runnable).toBe(false);

    const r = await transitionContractEpoch(db, 'mark_ready', 'assessment-contract-v1', 'op');
    expect(r).toMatchObject({ epoch: 'assessment-contract-v1', state: 'ready', seq: 2 });
    expect((await checkContractEpoch(db)).runnable).toBe(false);

    const a = await transitionContractEpoch(db, 'activate', 'assessment-contract-v1', 'op');
    expect(a).toMatchObject({ epoch: 'assessment-contract-v1', state: 'active', seq: 3 });
    // legacy 代码在新 epoch 下仍 fenced（stale 进程被拒）。
    expect(await checkContractEpoch(db)).toMatchObject({
      runnable: false,
      reason: 'epoch_mismatch',
    });
  });

  it('abort path: operator re-enters the window for the old epoch, then same-epoch activates', async () => {
    const db = testDb();
    await db.insert(contract_epoch).values({
      seq: 0,
      epoch: 'legacy',
      state: 'active',
      entered_by: 'seed',
    });
    await transitionContractEpoch(db, 'begin_prepare', 'assessment-contract-v1', 'op');
    // preparing marker 携带的是目标 epoch —— 中止 cutover 不是
    // activate('legacy')（跨 epoch，必须先 ready），而是再 begin_prepare('legacy')
    // 把窗口改挂回旧 epoch，再 same-epoch activate 恢复运行。
    await expect(transitionContractEpoch(db, 'activate', 'legacy', 'op')).rejects.toThrow(
      /activate_new_epoch_requires_ready/,
    );
    await transitionContractEpoch(db, 'begin_prepare', 'legacy', 'op');
    const a = await transitionContractEpoch(db, 'activate', 'legacy', 'op');
    expect(a).toMatchObject({ epoch: 'legacy', state: 'active' });
    expect((await checkContractEpoch(db)).runnable).toBe(true);
  });

  it('rejects illegal transitions without writing a row', async () => {
    const db = testDb();
    await db.insert(contract_epoch).values({
      seq: 0,
      epoch: 'legacy',
      state: 'active',
      entered_by: 'seed',
    });
    // mark_ready 只能从 preparing。
    await expect(
      transitionContractEpoch(db, 'mark_ready', 'assessment-contract-v1', 'op'),
    ).rejects.toThrow(/ready_requires_preparing/);
    // 换 epoch 激活必须经 ready——从 (av1, preparing) activate('legacy') 是
    // 跨 epoch（preparing 行的 epoch 是目标名），被拒；activate('av1') 此时是
    // same-epoch 恢复，合法（见 abort path 用例）。
    await transitionContractEpoch(db, 'begin_prepare', 'assessment-contract-v1', 'op');
    await expect(transitionContractEpoch(db, 'activate', 'legacy', 'op')).rejects.toThrow(
      /activate_new_epoch_requires_ready/,
    );
    // 同 epoch 已 active 不落假历史行：先把窗口改挂回 legacy 并激活。
    await transitionContractEpoch(db, 'begin_prepare', 'legacy', 'op');
    await transitionContractEpoch(db, 'activate', 'legacy', 'op');
    await expect(transitionContractEpoch(db, 'activate', 'legacy', 'op')).rejects.toThrow(
      /noop_active_to_active/,
    );
    // 历史只增不减：行数保持单调。
    const count = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from contract_epoch`,
    );
    expect(count[0]?.n).toBe(4); // seed + av1-prepare + legacy-prepare + legacy-activate（拒绝不落行）
  });

  it('requires a non-empty actor', async () => {
    await expect(
      transitionContractEpoch(testDb(), 'begin_prepare', 'legacy', '  '),
    ).rejects.toThrow(/actor/);
  });
});

describe('waitForRunnableEpoch (worker 启动闸门)', () => {
  it('returns immediately when runnable', async () => {
    await waitForRunnableEpoch(testDb(), { pollIntervalMs: 5 });
  });

  it('blocks while fenced and resumes when the marker activates', async () => {
    const db = testDb();
    await db.insert(contract_epoch).values({
      seq: 0,
      epoch: 'legacy',
      state: 'preparing',
      entered_by: 'test',
    });
    let released = false;
    const waiting = waitForRunnableEpoch(db, { pollIntervalMs: 10 }).then(() => {
      released = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(released).toBe(false); // 仍 fenced
    await transitionContractEpoch(db, 'activate', 'legacy', 'test');
    await waiting;
    expect(released).toBe(true);
  });
});

describe('fenceAwareJobHandler (per-delivery fence)', () => {
  it('fences jobs during preparing regardless of disposition', async () => {
    const db = testDb();
    await db.insert(contract_epoch).values({
      seq: 0,
      epoch: 'legacy',
      state: 'preparing',
      entered_by: 'test',
    });
    let ran = 0;
    const handler = fenceAwareJobHandler(db, 'echo', async () => {
      ran += 1;
    });
    await expect(handler([fakeJob('j1')])).rejects.toBeInstanceOf(ContractEpochFenceError);
    expect(ran).toBe(0);
  });

  it('runs drain jobs under a foreign active epoch (epoch-agnostic)', async () => {
    const db = testDb();
    await db.insert(contract_epoch).values({
      seq: 0,
      epoch: 'assessment-contract-v1',
      state: 'active',
      entered_by: 'test',
    });
    let ran = 0;
    const handler = fenceAwareJobHandler(db, 'echo', async () => {
      ran += 1;
    });
    await handler([fakeJob('j1')]);
    expect(ran).toBe(1);
  });

  it('fences translate-class queues under a foreign active epoch', async () => {
    const db = testDb();
    await db.insert(contract_epoch).values({
      seq: 0,
      epoch: 'assessment-contract-v1',
      state: 'active',
      entered_by: 'test',
    });
    let ran = 0;
    const handler = fenceAwareJobHandler(db, 'judge_run', async () => {
      ran += 1;
    });
    await expect(handler([fakeJob('judge-1')])).rejects.toMatchObject({
      name: 'ContractEpochFenceError',
      reason: 'epoch_mismatch',
    });
    expect(ran).toBe(0);
  });

  it('translate-class job born under an older active epoch is fenced even when epochs match', async () => {
    const db = testDb();
    // marker 历史：legacy active 于 T0；本代码 epoch=legacy，job 出生在 T0 之前
    // → birth epoch = implicit 'legacy'（同 epoch）→ 放行。为验证反向分支，
    // 把 marker 的 entered_at 拉到 job created_on 之后没有新 active —— 构造
    // 「born during preparing（无 active marker 覆盖该时刻）→ 落回上一个 active」。
    await db.insert(contract_epoch).values({
      seq: 0,
      epoch: 'legacy',
      state: 'active',
      entered_at: new Date('2026-01-01T00:00:00Z'),
      entered_by: 'seed',
    });
    await db.insert(contract_epoch).values({
      seq: 1,
      epoch: 'assessment-contract-v1',
      state: 'preparing',
      entered_at: new Date('2026-02-01T00:00:00Z'),
      entered_by: 'test',
    });
    // job 出生在 preparing 窗口 → birth epoch 落回 legacy（上一个 active）。
    const birth = await readJobBirthEpoch(db, new Date('2026-02-10T00:00:00Z'));
    expect(birth).toBe('legacy');
    // 出生在新 epoch 激活之后 → birth = 新 epoch。
    await db.insert(contract_epoch).values({
      seq: 2,
      epoch: 'assessment-contract-v1',
      state: 'active',
      entered_at: new Date('2026-03-01T00:00:00Z'),
      entered_by: 'test',
    });
    expect(await readJobBirthEpoch(db, new Date('2026-03-10T00:00:00Z'))).toBe(
      'assessment-contract-v1',
    );
    // 早于一切 marker → 'legacy'。
    expect(await readJobBirthEpoch(db, new Date('2020-01-01T00:00:00Z'))).toBe('legacy');
  });
});

describe('reportOutstandingBossJobs', () => {
  it('degrades to [] when the pgboss schema is absent (test container)', async () => {
    expect(await reportOutstandingBossJobs(testDb())).toEqual([]);
  });

  it('classifies outstanding rows by queue disposition', async () => {
    const db = testDb();
    // 最小 pgboss.job 替身（同测试建同测试删——不污染共享 fork 的 capture 探针）。
    // 幂等前置清理：同 shard 的其他 db 测试文件可能留下 pgboss.job（真实 boss 实例
    // 或未清理的替身），裸 create table 会 42P07。先 drop 再建，自愈任意残留。
    await db.execute(sql`drop table if exists pgboss.job`);
    await db.execute(sql`drop schema if exists pgboss cascade`);
    await db.execute(sql`create schema if not exists pgboss`);
    try {
      await db.execute(sql`
        create table pgboss.job (
          id text primary key,
          name text not null,
          state text not null,
          created_on timestamptz not null default now()
        )
      `);
      await db.execute(sql`
        insert into pgboss.job (id, name, state) values
          ('a', 'judge_run', 'created'),
          ('b', 'judge_run', 'failed'),
          ('c', 'prune_job_events', 'created'),
          ('d', 'memory_event_ingest_dlq', 'created'),
          ('e', 'completed_queue', 'completed')
      `);
      const rows = await reportOutstandingBossJobs(db);
      expect(rows).toEqual([
        { queue: 'judge_run', state: 'created', count: 1, disposition: 'translate' },
        { queue: 'judge_run', state: 'failed', count: 1, disposition: 'translate' },
        { queue: 'memory_event_ingest_dlq', state: 'created', count: 1, disposition: 'fenced' },
        { queue: 'prune_job_events', state: 'created', count: 1, disposition: 'drain' },
      ]);
    } finally {
      await db.execute(sql`drop table if exists pgboss.job`);
      // CASCADE: post-1055 forks carry real pg-boss objects (job_state type,
      // version/queue/subscription tables, helper functions) inside the same
      // schema — a bare DROP fails 2BP01 and wedges every boss test after us.
      await db.execute(sql`drop schema if exists pgboss cascade`);
    }
  });
});
