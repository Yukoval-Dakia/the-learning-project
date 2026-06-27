// YUK-474 — 动态供题 refill 集成 db 测（真实 Postgres）。
//
// 覆盖：flag-off byte-identical no-op · 活跃学习 KC 池见底 → 真 demandToSupplyTarget 建 target →
// dispatch · 池 ≥ 阈值不补 · **与 nightly R1 共享 fingerprint**（共享 7d cooldown 的前提）· 经
// **真 dispatchSupplyTarget** 的 7d fingerprint cooldown（refill 第二次同缺口 → skip，不双派）。
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()。
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, knowledge, learning_item, question } from '@/db/schema';
import type { EnqueueFn } from '@/server/question-supply/dispatcher';
import { demandToSupplyTarget } from '@/server/quiz/matcher';
import { resetDb } from '../../../tests/helpers/db';
import {
  REFILL_POOL_THRESHOLD,
  type RefillDeps,
  refillActiveLearningPools,
  refillThinPools,
} from './refill';
import { discoverSupplyTargets, targetFingerprint } from './target-discovery';

async function seedKnowledge(id: string, domain = 'wenyan') {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedActiveLearningItem(knowledgeIds: string[]) {
  const now = new Date();
  await db.insert(learning_item).values({
    id: createId(),
    source: 'test',
    title: 'active item',
    content: '',
    knowledge_ids: knowledgeIds,
    status: 'active',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedQuestion(knowledgeIds: string[], opts: { draft_status?: string | null } = {}) {
  const now = new Date();
  const id = createId();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Q ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'test',
    metadata: null as never,
    draft_status: opts.draft_status ?? null,
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

/** 捕获 dispatch 的 fake（不打真 pg-boss / 不跑真 route-plan）。 */
function captureDispatch() {
  const calls: Array<{ knowledgeIds: string[]; fingerprint: string; gapKind: string }> = [];
  const dispatch: NonNullable<RefillDeps['dispatch']> = async (_db, target) => {
    calls.push({
      knowledgeIds: target.knowledgeIds,
      fingerprint: target.fingerprint,
      gapKind: target.gapKind,
    });
    return {
      targetId: target.id,
      fingerprint: target.fingerprint,
      routePlan: [],
      chosenRoute: 'quiz_gen',
      status: 'dispatched',
      jobId: 'job-1',
      stopCondition: 'dispatched',
      reason: target.reason,
    };
  };
  return { calls, dispatch };
}

describe('refillActiveLearningPools (YUK-474)', () => {
  beforeEach(async () => {
    await resetDb();
    process.env.QUESTION_SUPPLY_REFILL_ENABLED = 'true';
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.QUESTION_SUPPLY_REFILL_ENABLED;
  });

  it('flag off → byte-identical no-op：返 []、dispatch 不被调（即便池见底）', async () => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.QUESTION_SUPPLY_REFILL_ENABLED;
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]); // 零题 → 池见底，但 flag off 必须不动。
    const { calls, dispatch } = captureDispatch();
    const out = await refillActiveLearningPools(db, { dispatch });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('活跃学习 KC 池见底（0 题）→ 真 demandToSupplyTarget 建 frontier_zero target → dispatch', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]); // 零可用题。
    const { calls, dispatch } = captureDispatch();
    const out = await refillActiveLearningPools(db, { dispatch });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ knowledgeId: kid, poolCount: 0, action: 'dispatched' });
    expect(calls).toHaveLength(1);
    expect(calls[0].knowledgeIds).toEqual([kid]);
    expect(calls[0].gapKind).toBe('frontier_zero');
  });

  it('draft 题不算活跃池：只有 draft 题的 KC 仍触发 refill', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    await seedQuestion([kid], { draft_status: 'draft' }); // draft 不计入活跃池。
    const { calls, dispatch } = captureDispatch();
    const out = await refillActiveLearningPools(db, { dispatch });
    // poolCount 计 non-draft → 0 → 见底 → dispatch。
    expect(out[0]).toMatchObject({ knowledgeId: kid, poolCount: 0, action: 'dispatched' });
    expect(calls).toHaveLength(1);
  });

  it('池 ≥ 阈值（2 道 active 题）→ above-threshold，不 dispatch', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    await seedQuestion([kid]);
    await seedQuestion([kid]); // 2 道 active = 阈值。
    const { calls, dispatch } = captureDispatch();
    const out = await refillActiveLearningPools(db, { dispatch });
    expect(out[0]).toMatchObject({
      knowledgeId: kid,
      poolCount: REFILL_POOL_THRESHOLD,
      action: 'above-threshold',
    });
    expect(calls).toHaveLength(0);
  });

  it('无活跃 learning_item → 无候选 KC → 返 []（不扫库）', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    // 故意不 seed active learning_item。
    const { calls, dispatch } = captureDispatch();
    const out = await refillActiveLearningPools(db, { dispatch });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('refill 的 frontier_zero fingerprint 与 nightly 扫描器 R1 目标逐字相同（共享 7d cooldown 前提）', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]); // 零题 → nightly 也会产 R1 frontier_zero。

    // refill 侧：真 demandToSupplyTarget（gap=阈值）。
    const refillTarget = await demandToSupplyTarget(
      db,
      { knowledgeId: kid, gapType: 'frontier_zero', limit: REFILL_POOL_THRESHOLD },
      REFILL_POOL_THRESHOLD,
    );
    // nightly 侧：discoverSupplyTargets → scanCoverageGaps R1。
    const nightlyTargets = await discoverSupplyTargets(db);
    const nightlyR1 = nightlyTargets.find(
      (t) => t.knowledgeIds[0] === kid && t.gapKind === 'frontier_zero',
    );
    expect(nightlyR1).toBeDefined();
    // fingerprint 逐字相同 → dispatcher 的 7d cooldown 在两路之间共享。
    expect(refillTarget.fingerprint).toBe(nightlyR1?.fingerprint);
    // 同时与独立重算的 targetFingerprint 对账（防两边漂移）。
    expect(refillTarget.fingerprint).toBe(
      targetFingerprint({
        subjectId: refillTarget.subjectId,
        knowledgeIds: [kid],
        kind: 'any',
        difficultyBand: 'near',
        gapKind: 'frontier_zero',
        minSourceTier: 2,
      }),
    );
  });

  it('经真 dispatchSupplyTarget：同缺口第二次 refill 命中 7d cooldown → skip，不双 enqueue', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]); // 零题，缺口不会被 fake 满足 → 第二次仍见底。

    const enqueued: Array<{ queue: string }> = [];
    const enqueue: EnqueueFn = async (queue) => {
      enqueued.push({ queue });
      return `job-${enqueued.length}`;
    };
    // 真 dispatchSupplyTarget（默认）+ 注入 enqueue + tavilyAvailable 让路由稳定可派。
    const deps: RefillDeps = {
      dispatchDeps: { enqueue, tavilyAvailable: () => true, actorRef: 'question_supply_refill' },
    };

    // 第一次：真派（enqueue 一次，写 dispatched 事件）。
    const first = await refillActiveLearningPools(db, deps);
    expect(first[0]).toMatchObject({ knowledgeId: kid, action: 'dispatched' });
    expect(enqueued).toHaveLength(1);

    // 第二次：同 fingerprint 在 7d 窗内 → dispatcher cooldown SKIP（不再 enqueue）。
    const second = await refillActiveLearningPools(db, deps);
    expect(second[0]).toMatchObject({ knowledgeId: kid, action: 'skipped-cooldown' });
    expect(enqueued).toHaveLength(1); // 没有第二次 enqueue。

    // 观测：dispatcher emit 了 experimental:question_supply 事件（dispatched + skipped 各至少一条）。
    const events = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.action, 'experimental:question_supply'));
    const statuses = events.map((e) => (e.payload as { status?: string }).status);
    expect(statuses).toContain('dispatched');
    expect(statuses).toContain('skipped');
  });
});

describe('refillThinPools — explicit KC set (YUK-474)', () => {
  beforeEach(async () => {
    await resetDb();
    process.env.QUESTION_SUPPLY_REFILL_ENABLED = 'true';
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.QUESTION_SUPPLY_REFILL_ENABLED;
  });

  it('混合：thin KC 派、足量 KC 跳过（单次调用内分别裁决）', async () => {
    const thin = createId();
    const full = createId();
    await seedKnowledge(thin);
    await seedKnowledge(full);
    await seedQuestion([full]);
    await seedQuestion([full]); // full 有 2 道 active。
    const { calls, dispatch } = captureDispatch();
    const out = await refillThinPools(db, [thin, full], { dispatch });
    expect(out.find((o) => o.knowledgeId === thin)).toMatchObject({
      action: 'dispatched',
      poolCount: 0,
    });
    expect(out.find((o) => o.knowledgeId === full)).toMatchObject({ action: 'above-threshold' });
    expect(calls.map((c) => c.knowledgeIds[0])).toEqual([thin]);
  });
});
