// YUK-474 — 动态供题 refill 决策逻辑单测（no-DB；countActive/buildTarget/dispatch 全注入 fake）。
// flag 门 / 阈值触发 / 去重 / in-flight 节流 / dispatch status 映射 / per-KC 失败隔离。
// @/db/client 仅 type-only（erased），不连库——故落 unit 分区（enumerated 进 vitest.shared.ts，
// 与 target-discovery.test.ts 同款）。真 demandToSupplyTarget fingerprint + 真池计数 + 真 event
// cooldown 的集成验证在 refill.db.test.ts。
import type { Db } from '@/db/client';
import type { DispatchResult } from '@/server/question-supply/dispatcher';
import type { QuestionSupplyTarget } from '@/server/question-supply/target-discovery';
import type { Demand } from '@/server/quiz/matcher';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFILL_POOL_THRESHOLD, type RefillDeps, refillThinPools } from './refill';

const db = {} as unknown as Db; // 全 seam 注入 → db 永不被触碰。

function dispatchResult(status: DispatchResult['status']): DispatchResult {
  return {
    targetId: 't1',
    fingerprint: 'fp',
    routePlan: [],
    chosenRoute: status === 'manual' ? null : 'quiz_gen',
    status,
    jobId: status === 'dispatched' ? 'job1' : null,
    stopCondition: status,
    reason: 'test',
  };
}

function fakeTarget(demand: Demand, gap: number): QuestionSupplyTarget {
  return {
    id: 'target-1',
    fingerprint: `fp:${demand.knowledgeId}`,
    gapKind: 'frontier_zero',
    subjectId: 'subj',
    knowledgeIds: [demand.knowledgeId],
    kind: 'any',
    difficultyBand: 'near',
    desiredCount: gap,
    minSourceTier: 2,
    routePreference: [],
    priority: 1,
    reason: 'test',
    constraints: {},
  };
}

// over 接受**裸 impl**（非 vi.fn）；helper 各包一层 vi.fn —— 返回的 mock 既保留精确签名（可赋给
// RefillDeps 字段），又带 .mock/.toHaveBeenCalled* 供断言（避免 ReturnType<typeof vi.fn> 丢签名）。
interface DepsOver {
  count?: (db: Db, kid: string) => Promise<number>;
  build?: (db: Db, demand: Demand, gap: number) => Promise<QuestionSupplyTarget>;
  dispatch?: NonNullable<RefillDeps['dispatch']>;
}
function deps(over: DepsOver = {}) {
  const count = vi.fn(over.count ?? (async (_db: Db, _kid: string) => 0));
  const build = vi.fn(
    over.build ?? (async (_db: Db, demand: Demand, gap: number) => fakeTarget(demand, gap)),
  );
  const dispatch = vi.fn(over.dispatch ?? (async () => dispatchResult('dispatched')));
  const d: RefillDeps = { countActiveQuestions: count, buildTarget: build, dispatch };
  return { d, count, build, dispatch };
}

describe('refillThinPools (YUK-474)', () => {
  beforeEach(() => {
    process.env.QUESTION_SUPPLY_REFILL_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.QUESTION_SUPPLY_REFILL_ENABLED;
    vi.restoreAllMocks();
  });

  it('flag off → no-op：零 count、零 dispatch、返 []', async () => {
    delete process.env.QUESTION_SUPPLY_REFILL_ENABLED;
    const { d, count, dispatch } = deps();
    const out = await refillThinPools(db, ['kc-a'], d);
    expect(out).toEqual([]);
    expect(count).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('flag off via "false" 字符串 → no-op', async () => {
    process.env.QUESTION_SUPPLY_REFILL_ENABLED = 'false';
    const { d, dispatch } = deps();
    expect(await refillThinPools(db, ['kc-a'], d)).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('池 ≥ 阈值 → above-threshold，不 dispatch', async () => {
    const { d, build, dispatch } = deps({
      count: async () => REFILL_POOL_THRESHOLD,
    });
    const out = await refillThinPools(db, ['kc-a'], d);
    expect(out).toEqual([
      { knowledgeId: 'kc-a', poolCount: REFILL_POOL_THRESHOLD, action: 'above-threshold' },
    ]);
    expect(build).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('池见底（0 题）→ dispatch；gap = 阈值；demand gapType=frontier_zero', async () => {
    const { d, build, dispatch } = deps({ count: async () => 0 });
    const out = await refillThinPools(db, ['kc-a'], d);
    expect(out).toEqual([
      { knowledgeId: 'kc-a', poolCount: 0, action: 'dispatched', dispatchStatus: 'dispatched' },
    ]);
    // demand：单 KC、frontier_zero、limit=阈值；gap=阈值-0=阈值。
    expect(build).toHaveBeenCalledTimes(1);
    const [, demand, gap] = build.mock.calls[0];
    expect(demand).toMatchObject({
      knowledgeId: 'kc-a',
      gapType: 'frontier_zero',
      limit: REFILL_POOL_THRESHOLD,
    });
    expect(gap).toBe(REFILL_POOL_THRESHOLD);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('池 thin（1 题，阈值 2）→ dispatch；gap = 阈值-1（补齐到阈值）', async () => {
    const { d, build } = deps({ count: async () => 1 });
    const out = await refillThinPools(db, ['kc-a'], d);
    expect(out[0]).toMatchObject({ poolCount: 1, action: 'dispatched' });
    const [, , gap] = build.mock.calls[0];
    expect(gap).toBe(REFILL_POOL_THRESHOLD - 1);
  });

  it('in-request 去重：同 KC 多次引用塌成一次 count + 一次 dispatch', async () => {
    const { d, count, dispatch } = deps({ count: async () => 0 });
    const out = await refillThinPools(db, ['kc-a', 'kc-a', 'kc-a'], d);
    expect(out).toHaveLength(1);
    expect(count).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('空/falsy KC 被过滤', async () => {
    const { d, count } = deps();
    const out = await refillThinPools(db, ['', ''], d);
    expect(out).toEqual([]);
    expect(count).not.toHaveBeenCalled();
  });

  it.each([
    ['skipped', 'skipped-cooldown'],
    ['manual', 'manual'],
    ['failed', 'failed'],
  ] as const)('dispatch status %s → action %s', async (status, action) => {
    const { d } = deps({
      count: async () => 0,
      dispatch: async () => dispatchResult(status),
    });
    const out = await refillThinPools(db, ['kc-a'], d);
    expect(out[0]).toMatchObject({ action, dispatchStatus: status });
  });

  it('单 KC count 抛错 → 该 KC failed，其余 KC 仍处理（best-effort 隔离）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d, dispatch } = deps({
      count: async (_db: Db, kid: string) => {
        if (kid === 'kc-bad') throw new Error('boom');
        return 0;
      },
      dispatch: async () => dispatchResult('dispatched'),
    });
    const out = await refillThinPools(db, ['kc-bad', 'kc-ok'], d);
    expect(out.find((o) => o.knowledgeId === 'kc-bad')).toMatchObject({
      action: 'failed',
      poolCount: null,
    });
    expect(out.find((o) => o.knowledgeId === 'kc-ok')).toMatchObject({ action: 'dispatched' });
    expect(dispatch).toHaveBeenCalledTimes(1); // 只 kc-ok 派。
  });

  it('in-flight 节流（open Q1/3）：同 KC 并发 → 第二次 in-flight，仅一次 dispatch', async () => {
    // 用 deferred count 卡住第一次调用，制造「在飞」窗口。
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { d, dispatch } = deps({
      count: async () => {
        await gate;
        return 0;
      },
      dispatch: async () => dispatchResult('dispatched'),
    });

    const first = refillThinPools(db, ['kc-a'], d); // 占住 in-flight（卡在 count）。
    // 让 first 跑到 await gate（microtask 让出）。
    await Promise.resolve();
    const second = await refillThinPools(db, ['kc-a'], d); // 同 KC → in-flight 跳过。
    expect(second).toEqual([{ knowledgeId: 'kc-a', poolCount: null, action: 'in-flight' }]);

    release();
    const firstOut = await first;
    expect(firstOut[0]).toMatchObject({ action: 'dispatched' });
    expect(dispatch).toHaveBeenCalledTimes(1); // 只 first 真派。
  });
});
