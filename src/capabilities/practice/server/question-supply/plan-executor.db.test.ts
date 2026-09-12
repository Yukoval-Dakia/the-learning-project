// YUK-988 (Supply-Agent/3) — executeSupplyPlan db 测试（E3 Slice 3）。
//
// 真实 store seam（store-sourced-question.ts）打真 db；jyeoo/web/quiz_gen/proposal
// 四个外部相位全部注入 fake。锁死的行为面：
//   (a) plan_event_id 幂等短路（不产生任何新写）；
//   (b) jyeoo 路由批量吸收：anchor 命中 acquired、异 KC opportunistic、全量 commit；
//   (c) jyeoo 预算耗尽 → skipped → 回落 web 路由；
//   (d) web failureClass 回落 quiz_gen enqueue（payload 镜像 dispatcher 字段族）；
//   (e) web 超发 count cap：只 commit 还需要的，锚点强制首位；
//   (f) web duplicate_exact：不计 acquired，批内继续，后继候选补齐；
//   (g) imageCandidates → writeImageCandidateProposal（旧 sourcing 行为镜像）。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourcedQuestionT, SourcingImageCandidateT } from '@/core/schema/sourcing';
import { event, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import type { SupplyTraceV1T } from './evidence-demand';
import {
  type JyeooCandidate,
  type JyeooFetchCandidatesResult,
  canonicalJyeooQuestionHash,
} from './jyeoo-candidates';
import {
  type ExecuteSupplyPlanDeps,
  type ImageCandidateProposalArgs,
  type ItemExecutionResult,
  type QuizGenDispatchPayload,
  type RouteExecutionTally,
  type RunWebFetchCandidatesFn,
  SUPPLY_EXECUTOR_EVENT_ACTION,
  SUPPLY_EXECUTOR_ITEM_EVENT_ACTION,
  type SupplyDemandItem,
  executeSupplyPlan,
} from './plan-executor';
import type { WebCandidate } from './web-candidates';

const db = testDb();

beforeEach(() => resetDb());

const NOW = new Date('2026-09-11T10:00:00Z');

async function seedTree(): Promise<void> {
  await db.insert(knowledge).values([
    {
      id: 'math-root',
      name: '数学',
      domain: 'math',
      parent_id: null,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-sets',
      name: '集合',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-functions',
      name: '函数',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
}

// ── fixtures（长题面、嵌套结构、真实 URL——拒绝单字段 happy path） ─────────────

function setsQuestion(): SourcedQuestionT {
  return {
    kind: 'short_answer',
    prompt_md:
      '已知集合 A={x∈R | x²-5x+6=0}，B={x∈R | 0<x<5}，求 A∩B，并用区间表示结果。' +
      '若集合 C 满足 A∪C=B，写出所有可能的集合 C。',
    reference_md:
      '【答案】A∩B={2,3}=[2,3]；C 可取 {2,3,4 的补全集合……}（详见解析）\n' +
      '【分析】先解二次方程求 A，再与区间 B 取交。\n' +
      '【解答】x²-5x+6=0 ⇒ x=2 或 x=3，故 A={2,3}；B=(0,5) 包含 2,3 ⇒ A∩B={2,3}。',
    difficulty: 3,
    source_url: 'https://www.jyeoo.com/math2/ques/detail/sets-intersect-101',
    source_title: '2025 年某校高二期中数学卷 · 第 5 题',
    knowledge_ids: [],
    extract: '集合 A={2,3}，B=(0,5)，求 A∩B 并讨论满足 A∪C=B 的集合 C。答案 {2,3}。',
  } as SourcedQuestionT;
}

function setsComplementQuestion(): SourcedQuestionT {
  return {
    kind: 'short_answer',
    prompt_md:
      '设全集 U={x∈Z | -3≤x≤3}，集合 A={x | x²<4 且 x∈U}，求 ∁ᵤA 的元素之和。' +
      '进一步：若 B={x | |x|=2 且 x∈U}，判断 B 与 ∁ᵤA 的包含关系并证明。',
    reference_md:
      '【答案】元素之和为 0\n【分析】U={-3,-2,-1,0,1,2,3}，A={-1,0,1}，∁ᵤA={-3,-2,2,3}。\n' +
      '【解答】U 中满足 x²<4 的是 -1,0,1，故余集 {-3,-2,2,3}，元素之和 -3+(-2)+2+3=0；' +
      'B={-2,2}⊂∁ᵤA，包含关系成立。',
    difficulty: 4,
    source_url: 'https://www.jyeoo.com/math2/ques/detail/sets-complement-202',
    source_title: '2026 年某重点中学月考卷 · 压轴第 19 题',
    knowledge_ids: [],
    extract: '全集 U={-3..3 的整数}，A={x|x²<4}，求余集元素之和。答案 0。',
  } as SourcedQuestionT;
}

function functionsDomainQuestion(): SourcedQuestionT {
  return {
    kind: 'choice',
    prompt_md:
      '函数 f(x)=√(x-1) + 1/(x-2) 的定义域为（　　）。\n\n' +
      '注：根号内表达式需非负，且分母不得为零；请同时考虑两个约束的交集。',
    choices_md: ['A. [1,2)', 'B. [1,2)∪(2,+∞)', 'C. (1,2)∪(2,+∞)', 'D. [1,+∞)'],
    reference_md: '【答案】B\n【分析】x-1≥0 且 x≠2 ⇒ [1,2)∪(2,+∞)。',
    difficulty: 2,
    source_url: 'https://www.jyeoo.com/math2/ques/detail/functions-domain-303',
    source_title: '2025 年高一函数专项练习 · 第 12 题',
    knowledge_ids: [],
    extract: '求 f(x)=√(x-1)+1/(x-2) 的定义域。答案 [1,2)∪(2,+∞)。',
  } as SourcedQuestionT;
}

async function hashOf(q: SourcedQuestionT): Promise<string> {
  return `sha256:${await canonicalJyeooQuestionHash(q, { images: [], attachedSources: new Set() })}`;
}

async function jyeooCandidateOf(
  q: SourcedQuestionT,
  hints: string[],
  candidateId: string,
): Promise<JyeooCandidate> {
  return {
    candidateId,
    question: q,
    extractionHash: await hashOf(q),
    knowledgeHints: hints,
    sourceId: `jyeoo-${candidateId}`,
    figures: null,
    imageRefs: null,
    structured: null,
    stagedAssetIds: [],
  };
}

async function webCandidateOf(
  q: SourcedQuestionT,
  candidateId: string,
  knowledgeIds: string[],
): Promise<WebCandidate> {
  return {
    candidateId,
    question: { ...q, knowledge_ids: knowledgeIds },
    extractionHash: await hashOf(q),
    sourceId: null,
    knowledgeHints: [],
    stagedAssetIds: [],
  };
}

function jyeooOk(
  candidates: JyeooCandidate[],
  runId = 'jyeoo_run_test',
): JyeooFetchCandidatesResult {
  return {
    status: 'ok',
    runId,
    candidates,
    dropped: [],
    counts: {
      requested: candidates.length,
      fetched: candidates.length,
      validated: candidates.length,
      invalid: 0,
      filtered_url: 0,
      filtered_kind: 0,
      filtered_band: 0,
      filtered_image: 0,
      deduped_exact: 0,
      near_dup_in_batch: 0,
      candidates: candidates.length,
    },
    budget: { dailyBudget: 40, remainingBefore: 40, remainingAfter: 40 - candidates.length },
  };
}

function webOk(candidates: WebCandidate[], imageCandidates: SourcingImageCandidateT[] = []) {
  return {
    status: 'ok' as const,
    candidates,
    imageCandidates,
    queryPlan: ['site:example.com 集合 交集 高中数学', '集合 运算 例题'],
    fetchedAt: NOW.toISOString(),
    taskRunId: 'task_run_web_1',
    costUsd: 0.12,
  };
}

type WebImageCandidate = SourcingImageCandidateT;

function itemOf(overrides: Partial<SupplyDemandItem> = {}): SupplyDemandItem {
  return {
    demandId: 'demand:v1:math:kc-sets',
    knowledgeId: 'kc-sets',
    kind: 'any',
    difficultyBand: null,
    count: 2,
    routePreference: ['jyeoo_fetch', 'sourcing_web', 'quiz_gen'],
    ...overrides,
  };
}

function baseDeps(web: RunWebFetchCandidatesFn): ExecuteSupplyPlanDeps {
  return {
    runWebFetchCandidates: web,
    enqueueQuizGen: async () => 'job-unused',
    enqueueSourceVerify: async () => {},
    now: () => NOW,
  };
}

async function executorEvents() {
  return db.select().from(event).where(eq(event.action, SUPPLY_EXECUTOR_EVENT_ACTION));
}

async function executorItemEvents() {
  return db.select().from(event).where(eq(event.action, SUPPLY_EXECUTOR_ITEM_EVENT_ACTION));
}

async function storeCanaries() {
  return db.select().from(event).where(eq(event.action, 'experimental:store_sourced_question'));
}

// ── (a) 幂等 ─────────────────────────────────────────────────────────────────

describe('executeSupplyPlan — idempotency', () => {
  it('short-circuits on a prior executor event for the same plan_event_id', async () => {
    await seedTree();
    await writeEvent(db, {
      id: 'prior-exec-evt-1',
      actor_kind: 'agent',
      actor_ref: 'supply_executor',
      action: SUPPLY_EXECUTOR_EVENT_ACTION,
      subject_kind: 'query',
      subject_id: 'plan-evt-1',
      outcome: 'success',
      payload: { plan_event_id: 'plan-evt-1', executed_at: NOW.toISOString(), per_item: [] },
      created_at: NOW,
    });

    const web = vi.fn<RunWebFetchCandidatesFn>();
    const result = await executeSupplyPlan(
      { db, planEventId: 'plan-evt-1', items: [itemOf()] },
      baseDeps(web),
    );

    expect(result).toEqual({ status: 'already_executed', priorEventId: 'prior-exec-evt-1' });
    expect(web).not.toHaveBeenCalled();
    expect(await db.select().from(question)).toHaveLength(0);
    expect(await executorEvents()).toHaveLength(1); // 只有预置那条，无新写
  });

  it('resumes a partial plan by skipping demand ids with completed item events', async () => {
    await seedTree();
    await writeEvent(db, {
      id: 'prior-item-evt-1',
      actor_kind: 'agent',
      actor_ref: 'supply_executor',
      action: SUPPLY_EXECUTOR_ITEM_EVENT_ACTION,
      subject_kind: 'query',
      subject_id: 'plan-evt-resume',
      outcome: 'success',
      payload: {
        plan_event_id: 'plan-evt-resume',
        demand_id: 'demand:v1:math:kc-sets',
        routes: [{ route: 'sourcing_web', status: 'ok', acquired: 1, committed: 1 }],
      },
      created_at: NOW,
    });

    const functionCandidate = await webCandidateOf(
      functionsDomainQuestion(),
      'webcand-resume-functions',
      ['kc-functions'],
    );
    const web = vi.fn<RunWebFetchCandidatesFn>(async (params) => {
      expect(params.input.anchorKnowledgeId).toBe('kc-functions');
      return webOk([functionCandidate]);
    });

    const result = await executeSupplyPlan(
      {
        db,
        planEventId: 'plan-evt-resume',
        items: [
          itemOf({ count: 1, routePreference: ['sourcing_web'] }),
          itemOf({
            demandId: 'demand:v1:math:kc-functions',
            knowledgeId: 'kc-functions',
            count: 1,
            routePreference: ['sourcing_web'],
          }),
        ],
      },
      baseDeps(web),
    );

    expect(web).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('executed');
    if (result.status !== 'executed') return;
    expect(result.results).toEqual([
      expect.objectContaining({
        demandId: 'demand:v1:math:kc-sets',
        skipped: 'already_executed_item',
        routes: [],
      }),
      expect.objectContaining({
        demandId: 'demand:v1:math:kc-functions',
        acquired: 1,
        committed: 1,
      }),
    ]);
    expect(await db.select().from(question)).toHaveLength(1);
    const itemEvents = await executorItemEvents();
    expect(itemEvents).toHaveLength(2);
    expect(
      itemEvents.map((row) => (row.payload as { demand_id?: string }).demand_id).sort(),
    ).toEqual(['demand:v1:math:kc-functions', 'demand:v1:math:kc-sets']);
  });
});

// ── (b) jyeoo 路由：批量吸收 + 归属 ──────────────────────────────────────────

describe('executeSupplyPlan — jyeoo route', () => {
  it('commits every fetched candidate: anchor hits acquired, other-KC opportunistic', async () => {
    await seedTree();
    const anchorQ1 = await jyeooCandidateOf(setsQuestion(), ['集合'], 'cand-jy-1');
    const anchorQ2 = await jyeooCandidateOf(setsComplementQuestion(), ['集合、补集'], 'cand-jy-2');
    const otherKc = await jyeooCandidateOf(functionsDomainQuestion(), ['函数'], 'cand-jy-3');

    const fetchInputs: unknown[] = [];
    const deps = baseDeps(vi.fn<RunWebFetchCandidatesFn>());
    deps.runJyeooFetchCandidates = vi.fn(async (params) => {
      fetchInputs.push(params.input);
      return jyeooOk([anchorQ1, anchorQ2, otherKc]);
    });

    const result = await executeSupplyPlan(
      {
        db,
        planEventId: 'plan-evt-2',
        jyeooFetch: { grade: 11 },
        items: [itemOf({ count: 2, routePreference: ['jyeoo_fetch'] })],
      },
      deps,
    );

    // sessionMax = min(count*2, 预算余额 40, 8) = 4；kind 'any' 不 pin。
    expect(fetchInputs).toHaveLength(1);
    expect(fetchInputs[0]).toMatchObject({ sessionMax: 4, subject: 'math2' });
    expect((fetchInputs[0] as { kind?: string }).kind).toBeUndefined();

    expect(result.status).toBe('executed');
    if (result.status !== 'executed') return;
    const item: ItemExecutionResult = result.results[0];
    expect(item.routes).toHaveLength(1);
    expect(item.routes[0]).toMatchObject({
      route: 'jyeoo_fetch',
      status: 'ok',
      acquired: 2,
      committed: 3,
      opportunistic: 1,
    });
    expect(result.totals).toEqual({
      items: 1,
      acquired: 2,
      committed: 3,
      opportunistic: 1,
      dispatched: 0,
    });

    // 全部 3 条入库：2 条锚 KC matched + 1 条异 KC（hints 解析到 kc-functions，matched）。
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(3);
    const byKc = new Map(rows.map((row) => [(row.knowledge_ids as string[])[0], row]));
    expect(byKc.get('kc-sets')?.knowledge_ids).toEqual(['kc-sets']);
    expect(byKc.get('kc-functions')?.knowledge_ids).toEqual(['kc-functions']);
    const functionsMeta = byKc.get('kc-functions')?.metadata as {
      attribution_state?: string;
    };
    expect(functionsMeta.attribution_state).toBe('matched');
    expect(byKc.get('kc-sets')?.source).toBe('web_sourced'); // jyeoo 路由同样走 web_sourced provenance

    // store canary 每候选一条（#598 单写规则在 seam 侧）；executor 完成事件恰好一条。
    expect(await storeCanaries()).toHaveLength(3);
    const execEvents = await executorEvents();
    expect(execEvents).toHaveLength(1);
    const execPayload = execEvents[0]?.payload as { plan_event_id?: string };
    expect(execPayload.plan_event_id).toBe('plan-evt-2');
  });
});

// ── (c) jyeoo 预算耗尽 → 回落 web ────────────────────────────────────────────

describe('executeSupplyPlan — jyeoo budget exhausted falls through to web', () => {
  it('records skipped:jyeoo_budget and acquires via the web route', async () => {
    await seedTree();
    // 预算账本：当日（Asia/Shanghai 自然日）success canary 已 fetched 40 = 默认预算耗尽。
    await writeEvent(db, {
      id: 'jyeoo-budget-ledger-1',
      actor_kind: 'agent',
      actor_ref: 'jyeoo_fetch',
      action: 'experimental:jyeoo_fetch',
      subject_kind: 'query',
      subject_id: 'jyeoo_run_seed',
      outcome: 'success',
      payload: { counts: { fetched: 40 }, budget: { dailyBudget: 40 } },
      created_at: new Date('2026-09-11T02:00:00Z'),
    });

    const jyeoo = vi.fn();
    const webQ = await webCandidateOf(setsQuestion(), 'webcand-kc-sets_1', ['kc-sets']);
    const webQ2 = await webCandidateOf(setsComplementQuestion(), 'webcand-kc-sets_2', ['kc-sets']);
    const deps = baseDeps(vi.fn(async () => webOk([webQ, webQ2])));
    deps.runJyeooFetchCandidates = jyeoo;

    const result = await executeSupplyPlan(
      {
        db,
        planEventId: 'plan-evt-3',
        jyeooFetch: { grade: 11 },
        items: [itemOf({ count: 2 })],
      },
      deps,
    );

    expect(jyeoo).not.toHaveBeenCalled(); // 预算 0 → 不 spawn，直接跳过
    expect(result.status).toBe('executed');
    if (result.status !== 'executed') return;
    const routes = result.results[0].routes;
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      route: 'jyeoo_fetch',
      status: 'skipped',
      skipped: 'jyeoo_budget',
    });
    expect(routes[1]).toMatchObject({ route: 'sourcing_web', status: 'ok', acquired: 2 });
    expect(result.results[0].acquired).toBe(2);
    expect(await db.select().from(question)).toHaveLength(2);
  });
});

// ── (d) web failureClass → 回落 quiz_gen ─────────────────────────────────────

describe('executeSupplyPlan — web failure falls through to quiz_gen', () => {
  it('records skipped:tavily_unavailable and enqueues a dispatcher-shaped payload', async () => {
    await seedTree();
    const enqueued: QuizGenDispatchPayload[] = [];
    const deps = baseDeps(
      vi.fn(async () => ({
        status: 'failed' as const,
        failureClass: 'tavily_unavailable' as const,
        detail: 'Tavily API key 未配置——web 路由不可执行',
      })),
    );
    deps.enqueueQuizGen = async (payload) => {
      enqueued.push(payload);
      return 'job-42';
    };

    const result = await executeSupplyPlan(
      {
        db,
        planEventId: 'plan-evt-4',
        items: [
          itemOf({
            count: 3,
            routePreference: ['sourcing_web', 'quiz_gen'],
            placementClaimId: 'claim-9',
          }),
        ],
      },
      deps,
    );

    expect(enqueued).toEqual([
      {
        trigger: 'knowledge',
        ref_id: 'kc-sets',
        knowledge_id: 'kc-sets',
        count: 3,
        exact_count: 3,
        placement_starter_claim_id: 'claim-9',
      },
    ]);

    expect(result.status).toBe('executed');
    if (result.status !== 'executed') return;
    const routes = result.results[0].routes;
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      route: 'sourcing_web',
      status: 'skipped',
      skipped: 'tavily_unavailable',
    });
    expect(routes[1]).toMatchObject({ route: 'quiz_gen', status: 'dispatched', job_id: 'job-42' });
    expect(result.totals.dispatched).toBe(1);
    // dispatched ≠ acquired：quiz_gen 异步走自身 verify 链，不冒充已获取。
    expect(result.results[0].acquired).toBe(0);
    expect(await db.select().from(question)).toHaveLength(0);
  });

  it('normalizes a thrown web error and falls through with a deterministic singleton key', async () => {
    await seedTree();
    const enqueueQuizGen = vi.fn(async () => 'job-after-llm-throw');
    const deps = baseDeps(
      vi.fn<RunWebFetchCandidatesFn>(async () => {
        throw new Error('provider connection reset');
      }),
    );
    deps.enqueueQuizGen = enqueueQuizGen;

    const result = await executeSupplyPlan(
      {
        db,
        planEventId: 'plan-evt-web-throw',
        items: [itemOf({ count: 1, routePreference: ['sourcing_web', 'quiz_gen'] })],
      },
      deps,
    );

    expect(result.status).toBe('executed');
    if (result.status !== 'executed') return;
    expect(result.results[0].routes).toEqual([
      expect.objectContaining({
        route: 'sourcing_web',
        status: 'skipped',
        skipped: 'llm',
        detail: 'provider connection reset',
      }),
      expect.objectContaining({
        route: 'quiz_gen',
        status: 'dispatched',
        job_id: 'job-after-llm-throw',
      }),
    ]);
    expect(enqueueQuizGen).toHaveBeenCalledWith(
      expect.objectContaining({ knowledge_id: 'kc-sets', count: 1, exact_count: 1 }),
      { singletonKey: 'supply_exec_plan-evt-web-throw_demand:v1:math:kc-sets' },
    );
  });
});

// ── (e) count cap + 锚点首位 ─────────────────────────────────────────────────

describe('executeSupplyPlan — web count cap', () => {
  it('commits only the needed count and forces the anchor first in knowledge_ids', async () => {
    await seedTree();
    const c1 = await webCandidateOf(setsQuestion(), 'webcand-1', ['kc-functions', 'kc-sets']);
    const c2 = await webCandidateOf(setsComplementQuestion(), 'webcand-2', ['kc-sets']);
    const c3 = await webCandidateOf(functionsDomainQuestion(), 'webcand-3', ['kc-functions']);

    const webInputs: unknown[] = [];
    const deps = baseDeps(
      vi.fn(async (params) => {
        webInputs.push(params.input);
        return webOk([c1, c2, c3]);
      }),
    );

    const result = await executeSupplyPlan(
      {
        db,
        planEventId: 'plan-evt-5',
        items: [itemOf({ count: 2, kind: 'choice', routePreference: ['sourcing_web'] })],
      },
      deps,
    );

    expect((webInputs[0] as { count: number; kind?: string }).count).toBe(2);
    expect((webInputs[0] as { count: number; kind?: string }).kind).toBe('choice');

    expect(result.status).toBe('executed');
    if (result.status !== 'executed') return;
    const routes: RouteExecutionTally[] = result.results[0].routes;
    expect(routes[0]).toMatchObject({
      route: 'sourcing_web',
      status: 'ok',
      acquired: 2,
      committed: 2,
    });

    // 只 commit 需要的 2 条（count cap）；第 3 条丢弃。
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(2);
    // c1 的候选 knowledge_ids=['kc-functions','kc-sets'] → 锚点强制首位后 ['kc-sets','kc-functions']。
    const anchored = rows.find((row) => (row.knowledge_ids as string[]).length === 2);
    expect(anchored?.knowledge_ids).toEqual(['kc-sets', 'kc-functions']);
  });
});

// ── (f) duplicate_exact → 批内继续 ───────────────────────────────────────────

describe('executeSupplyPlan — web duplicate_exact', () => {
  it('does not count the duplicate and completes via the later candidate', async () => {
    await seedTree();
    const dupQ = setsQuestion();
    const dupHash = await canonicalJyeooQuestionHash(dupQ, {
      images: [],
      attachedSources: new Set(),
    });
    await db.insert(question).values({
      id: 'q-existing',
      kind: 'short_answer',
      prompt_md: dupQ.prompt_md,
      reference_md: dupQ.reference_md,
      knowledge_ids: ['math-root'],
      difficulty: 3,
      source: 'jyeoo',
      metadata: null as never,
      draft_status: null,
      variant_depth: 0,
      canonical_content_hash: dupHash,
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });

    const dupCand = await webCandidateOf(dupQ, 'webcand-dup', ['kc-sets']);
    const freshCand = await webCandidateOf(setsComplementQuestion(), 'webcand-fresh', ['kc-sets']);
    const deps = baseDeps(vi.fn(async () => webOk([dupCand, freshCand])));

    const result = await executeSupplyPlan(
      {
        db,
        planEventId: 'plan-evt-6',
        items: [itemOf({ count: 1, routePreference: ['sourcing_web'] })],
      },
      deps,
    );

    expect(result.status).toBe('executed');
    if (result.status !== 'executed') return;
    expect(result.results[0].routes[0]).toMatchObject({
      route: 'sourcing_web',
      status: 'ok',
      acquired: 1,
      committed: 1,
      rejections: { duplicate_exact: 1 },
    });

    const [itemEvent] = await executorItemEvents();
    const itemPayload = itemEvent?.payload as { routes?: RouteExecutionTally[] };
    expect(itemPayload.routes?.[0]?.rejections).toEqual({ duplicate_exact: 1 });
    const [aggregateEvent] = await executorEvents();
    const aggregatePayload = aggregateEvent?.payload as {
      per_item?: Array<{ routes?: RouteExecutionTally[] }>;
    };
    expect(aggregatePayload.per_item?.[0]?.routes?.[0]?.rejections).toEqual({
      duplicate_exact: 1,
    });

    // 既有行吸收目标 KC（YUK-720 cross-KC merge），新草稿恰好 1 条（freshCand）。
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(2);
    const [existing] = await db.select().from(question).where(eq(question.id, 'q-existing'));
    expect(new Set(existing?.knowledge_ids)).toEqual(new Set(['math-root', 'kc-sets']));
    expect(rows.filter((row) => row.draft_status === 'draft')).toHaveLength(1);
  });
});

describe('executeSupplyPlan — route-specific supply trace', () => {
  it('overrides producer_route with the route that actually commits the candidate', async () => {
    await seedTree();
    const candidate = await webCandidateOf(setsQuestion(), 'webcand-trace-override', ['kc-sets']);
    const supplyTrace: SupplyTraceV1T = {
      schema_version: 1,
      demand_id: 'demand:v1:math:kc-sets',
      demand_version: 1,
      policy_version: 'supply-v2-phase-a',
      needed_by: '2026-09-20T00:00:00.000Z',
      allowed_uses: ['practice', 'diagnostic'],
      max_budget_micro_usd: 250_000,
      max_attempts: 3,
      trace_version: 1,
      trace_id: 'supply:demand:v1:math:kc-sets:target-sets',
      target_id: 'target-sets',
      target_fingerprint: 'fp-target-sets',
      producer_route: 'jyeoo_fetch',
    };

    const result = await executeSupplyPlan(
      {
        db,
        planEventId: 'plan-evt-trace-override',
        supplyTrace,
        items: [itemOf({ count: 1, routePreference: ['sourcing_web'] })],
      },
      baseDeps(vi.fn(async () => webOk([candidate]))),
    );

    expect(result.status).toBe('executed');
    const [stored] = await db.select().from(question);
    const metadata = stored?.metadata as { supply_trace?: SupplyTraceV1T };
    expect(metadata.supply_trace).toMatchObject({
      ...supplyTrace,
      producer_route: 'sourcing_web',
    });
  });
});

// ── (g) imageCandidates → proposal ───────────────────────────────────────────

describe('executeSupplyPlan — web image candidates', () => {
  it('writes one image_candidate proposal per image candidate with anchor attribution', async () => {
    await seedTree();
    const imageCandidates: WebImageCandidate[] = [
      {
        source_url: 'https://www.jyeoo.com/math2/paper/2025-gaoer-qimo/images/19.png',
        source_title: '2025 年某校高二期中卷 · 第 19 题（扫描版）',
        summary_md:
          '页面为整页扫描图：一道含双曲线与直线位置关系的解析几何大题，含两小问；' +
          '第 (2) 问需要联立方程并讨论判别式符号，题干全部嵌在图片中，无法直接提取文本。',
      },
      {
        source_url: 'https://www.jyeoo.com/math2/paper/2025-gaoer-qimo/images/19.png',
        source_title: '同 URL 重复上报（in-run 去重探针）',
        summary_md: '同上——应被 cooldown 去重，不产生第二条 proposal。',
      },
    ];
    const proposals: ImageCandidateProposalArgs[] = [];
    const deps = baseDeps(vi.fn(async () => webOk([], imageCandidates)));
    deps.writeImageCandidateProposal = async (args) => {
      proposals.push(args);
      return 'proposal-evt-1';
    };

    const result = await executeSupplyPlan(
      {
        db,
        planEventId: 'plan-evt-7',
        items: [itemOf({ count: 1, routePreference: ['sourcing_web'] })],
      },
      deps,
    );

    // in-run cooldown：同 URL 只写一条 proposal。
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toEqual({
      actor_ref: 'supply_executor',
      outcome: 'partial',
      payload: {
        kind: 'image_candidate',
        target: { subject_kind: 'source_asset', subject_id: null },
        reason_md: imageCandidates[0].summary_md,
        evidence_refs: [],
        proposed_change: {
          source_url: 'https://www.jyeoo.com/math2/paper/2025-gaoer-qimo/images/19.png',
          source_title: '2025 年某校高二期中卷 · 第 19 题（扫描版）',
          summary_md: imageCandidates[0].summary_md,
          knowledge_ids: ['kc-sets'],
        },
        cooldown_key:
          'image_candidate:https://www.jyeoo.com/math2/paper/2025-gaoer-qimo/images/19.png',
      },
      task_run_id: expect.any(String),
      created_at: NOW,
    } as ImageCandidateProposalArgs);

    expect(result.status).toBe('executed');
    if (result.status !== 'executed') return;
    // 图片候选不入 draft（ADR-0002）：文本候选为 0 → acquired 0，路由仍 ok。
    expect(result.results[0].routes[0]).toMatchObject({
      route: 'sourcing_web',
      status: 'ok',
      acquired: 0,
    });
    expect(await db.select().from(question)).toHaveLength(0);
  });
});
