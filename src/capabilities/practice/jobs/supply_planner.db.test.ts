// YUK-987 (985/E2) — supply_planner handler 行为测试（db 分区）。
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()。LLM 用 fake runAgentTaskFn
// （罐头 plan JSON / 捕获 input 断言重试反馈）；MCP 挂载用 stub buildMcpServerFn
// （fake runner 不消费）。扫描器（discoverSupplyTargets）走真 db——shadow 对比
// 的正确性依赖真确定性扫描输出。
//
// 覆盖：accepted（run/demand/shadow 三事件 + claim 透传 + cost 汇总）、rejected
// （fail closed：零 demand + rejected 事件 + job 不抛）、空计划合法、重试环
// （首轮废 → 次轮带 previous_rejection）、shadow 集合运算。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  event,
  knowledge,
  learning_item,
  mastery_state,
  placement_starter_claim,
  question,
} from '@/db/schema';
import type { SdkMcpServer } from '@/server/ai/tools/mcp-bridge';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { type SupplyPlannerDeps, runSupplyPlanner } from './supply_planner';

const db = testDb();

beforeEach(() => resetDb());

const NOW = new Date('2026-09-12T05:40:00+08:00');

async function seedKnowledge() {
  const now = new Date();
  await db.insert(knowledge).values([
    {
      id: 'kc-math-root',
      name: '数学',
      domain: 'math',
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    },
    {
      id: 'kc-1',
      name: '几何概型',
      domain: null,
      parent_id: 'kc-math-root',
      created_at: now,
      updated_at: now,
      version: 0,
    },
    {
      id: 'kc-2',
      name: '条件概率',
      domain: null,
      parent_id: 'kc-math-root',
      created_at: now,
      updated_at: now,
      version: 0,
    },
  ]);
}

async function seedQuestion(knowledgeIds: string[], draftStatus: string | null = null) {
  const now = new Date();
  await db.insert(question).values({
    id: `q-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'short_answer',
    prompt_md: '题面',
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'test',
    metadata: null,
    draft_status: draftStatus,
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedMastery(knowledgeId: string, evidenceCount: number, theta = 0.5) {
  await db.insert(mastery_state).values({
    id: `ms-${knowledgeId}`,
    subject_kind: 'knowledge',
    subject_id: knowledgeId,
    theta_hat: theta,
    evidence_count: evidenceCount,
  });
}

// 开放学习项引用的 KC 才进扫描器前缘（target-discovery.db.test.ts 同款种子）。
async function seedOpenLearningItem(knowledgeIds: string[]) {
  const now = new Date();
  await db.insert(learning_item).values({
    id: `li-${knowledgeIds.join('-')}`,
    source: 'test',
    title: 'open item',
    content: '',
    knowledge_ids: knowledgeIds,
    status: 'pending',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedPendingClaim(knowledgeId: string, claimId = 'claim-1') {
  const now = new Date();
  await db.insert(placement_starter_claim).values({
    id: claimId,
    fingerprint: `fp-${claimId}`,
    goal_id: `goal-${claimId}`,
    semantic_goal_revision_id: `rev-${claimId}`,
    subject_id: 'math',
    knowledge_id: knowledgeId,
    demand_id: `demand-${claimId}`,
    target_id: `target-${claimId}`,
    status: 'pending_dispatch',
    pg_boss_job_id: null,
    max_paid_attempts: 3,
    budget_limit_micro_usd: 1_000_000,
    known_cost_micro_usd: 0,
    next_reconcile_at: now,
    created_at: now,
    updated_at: now,
  });
}

function validPlanJson(items: Array<Record<string, unknown>> = []): string {
  return JSON.stringify({
    version: 1,
    items: items.length
      ? items
      : [
          {
            knowledge_id: 'kc-1',
            kind: 'choice',
            difficulty_band: 'near',
            count: 2,
            route_preference: ['sourcing_web'],
            rationale: '零覆盖前缘，补基础题',
          },
          {
            knowledge_id: 'kc-2',
            kind: 'any',
            difficulty_band: 'above',
            count: 3,
            route_preference: ['sourcing_web', 'quiz_gen'],
            rationale: 'claim 指向节点，诊断放置需要',
          },
        ],
    budget: { jyeoo_questions: 0 },
  });
}

interface CapturedCall {
  kind: string;
  input: Record<string, unknown>;
}

function fakeDeps(planTexts: string[]): { deps: SupplyPlannerDeps; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  const deps: SupplyPlannerDeps = {
    now: () => NOW,
    buildMcpServerFn: (() => ({}) as SdkMcpServer) as SupplyPlannerDeps['buildMcpServerFn'],
    runAgentTaskFn: (kind, input) => {
      calls.push({ kind, input: input as Record<string, unknown> });
      const text = planTexts[Math.min(i, planTexts.length - 1)] ?? '';
      i += 1;
      return Promise.resolve({ text, task_run_id: `run-${i}`, cost_usd: 0.001 * i });
    },
  };
  return { deps, calls };
}

async function eventsByAction(action: string) {
  const rows = await db.select().from(event).where(eq(event.action, action));
  return rows;
}

describe('runSupplyPlanner', () => {
  it('accepted：run/demand/shadow 三事件齐写，claim id 透传，cost 汇总', async () => {
    await seedKnowledge();
    await seedQuestion(['kc-1']); // kc-1 已有 1 道可用题
    await seedQuestion(['kc-2'], 'draft'); // kc-2 只有草稿
    await seedMastery('kc-2', 3);
    await seedPendingClaim('kc-2');
    await seedOpenLearningItem(['kc-2']); // kc-2 进扫描器前缘 → frontier_zero 目标
    const { deps, calls } = fakeDeps([validPlanJson()]);

    const result = await runSupplyPlanner(db, deps);

    expect(result.outcome).toBe('accepted');
    expect(result.planItems).toBe(2);
    expect(result.demandEvents).toBe(2);
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('SupplyPlanTask');

    // run 事件：accepted + 完整载荷 + cost 汇总（0.001 USD = 1000 micro）
    const runEvents = await eventsByAction('experimental:supply_planner');
    expect(runEvents).toHaveLength(1);
    const runEvent = runEvents[0];
    expect(runEvent.outcome).toBe('accepted');
    expect(runEvent.actor_kind).toBe('agent');
    const payload = runEvent.payload as Record<string, unknown>;
    expect(payload.version).toBe(1);
    expect((payload.plan as { items: unknown[] }).items).toHaveLength(2);
    expect(payload.task_run_ids).toEqual(['run-1']);
    expect(payload.pending_claim_ids).toEqual(['claim-1']);
    expect(runEvent.cost_micro_usd).toBe(1000);
    // ops 事件显式退出 mem0 事实层
    expect(runEvent.ingest_at).not.toBeNull();

    // demand 事件：逐项 manual；kc-2 带 placement_claim_id 透传
    const demandEvents = await eventsByAction('experimental:supply_planner_demand');
    expect(demandEvents).toHaveLength(2);
    expect(demandEvents.every((row) => row.outcome === 'manual')).toBe(true);
    expect(demandEvents.every((row) => row.subject_kind === 'knowledge')).toBe(true);
    const kc2Demand = demandEvents.find((row) => row.subject_id === 'kc-2');
    if (!kc2Demand) throw new Error('kc-2 demand event missing');
    const kc2Payload = kc2Demand.payload as { placement_claim_id?: string; plan_event_id: string };
    expect(kc2Payload.placement_claim_id).toBe('claim-1');
    expect(kc2Payload.plan_event_id).toBe(runEvent.id);
    const kc1Demand = demandEvents.find((row) => row.subject_id === 'kc-1');
    if (!kc1Demand) throw new Error('kc-1 demand event missing');
    const kc1Payload = kc1Demand.payload as { placement_claim_id?: string };
    expect(kc1Payload.placement_claim_id).toBeUndefined();

    // shadow 事件：planner 需求 vs 扫描器目标（同窗口）
    const shadowEvents = await eventsByAction('experimental:supply_planner_shadow');
    expect(shadowEvents).toHaveLength(1);
    const shadowPayload = shadowEvents[0].payload as {
      planner_item_count: number;
      scanner_target_count: number;
      overlap: string[];
      planner_only: string[];
      scanner_only: string[];
    };
    expect(shadowPayload.planner_item_count).toBe(2);
    // kc-2 有掌握信号且零可用题 → 扫描器 R1 目标应含 kc-2
    expect(shadowPayload.scanner_target_count).toBeGreaterThan(0);
    expect(shadowPayload.overlap).toContain('kc-2');
  });

  it('rejected：门拒 fail closed（零 demand、rejected 事件、job 不抛），shadow 仍写', async () => {
    await seedKnowledge();
    // 两轮都出查无此点的计划
    const ghostPlan = JSON.stringify({
      version: 1,
      items: [
        {
          knowledge_id: 'kc-ghost',
          kind: 'choice',
          difficulty_band: 'near',
          count: 1,
          route_preference: ['quiz_gen'],
          rationale: '幻觉节点',
        },
      ],
      budget: { jyeoo_questions: 0 },
    });
    const { deps, calls } = fakeDeps([ghostPlan]);

    const result = await runSupplyPlanner(db, deps);

    expect(result.outcome).toBe('rejected');
    expect(result.demandEvents).toBe(0);
    expect(result.attempts).toBe(2); // 有界重生成 2 轮后停
    expect(calls).toHaveLength(2);
    // 次轮携带 previous_rejection 反馈
    expect(String(calls[1]?.input.previous_rejection ?? '')).toContain('kc-ghost');

    const runEvents = await eventsByAction('experimental:supply_planner');
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0].outcome).toBe('rejected');
    const payload = runEvents[0].payload as { plan: unknown; rejections: string[][] };
    expect(payload.plan).toBeNull();
    expect(payload.rejections).toHaveLength(2);

    expect(await eventsByAction('experimental:supply_planner_demand')).toHaveLength(0);
    // shadow 不受门结果影响
    const shadowEvents = await eventsByAction('experimental:supply_planner_shadow');
    expect(shadowEvents).toHaveLength(1);
    const shadowPayload = shadowEvents[0].payload as { planner_item_count: number };
    expect(shadowPayload.planner_item_count).toBe(0);
  });

  it('空计划是合法产出：accepted、零 demand、shadow 记录 planner=0', async () => {
    await seedKnowledge();
    const emptyPlan = JSON.stringify({ version: 1, items: [], budget: { jyeoo_questions: 0 } });
    const { deps } = fakeDeps([emptyPlan]);

    const result = await runSupplyPlanner(db, deps);

    expect(result.outcome).toBe('accepted');
    expect(result.planItems).toBe(0);
    expect(result.demandEvents).toBe(0);
    const runEvents = await eventsByAction('experimental:supply_planner');
    expect(runEvents[0].outcome).toBe('accepted');
    expect(await eventsByAction('experimental:supply_planner_demand')).toHaveLength(0);
    expect(await eventsByAction('experimental:supply_planner_shadow')).toHaveLength(1);
  });

  it('重试环：首轮废输出 → 次轮带 previous_rejection → accepted attempts=2', async () => {
    await seedKnowledge();
    const { deps, calls } = fakeDeps(['这不是 JSON', validPlanJson()]);

    const result = await runSupplyPlanner(db, deps);

    expect(result.outcome).toBe('accepted');
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.input.previous_rejection ?? '')).toContain('invalid JSON');
    // 两轮 task_run_id 都留痕；cost 汇总两轮（0.001+0.002=3000 micro）
    const runEvents = await eventsByAction('experimental:supply_planner');
    const payload = runEvents[0].payload as { task_run_ids: string[] };
    expect(payload.task_run_ids).toEqual(['run-1', 'run-2']);
    expect(runEvents[0].cost_micro_usd).toBe(3000);
  });

  it('planner 输入喂原始信号而非扫描器结论：含 frontier/claims/预算，无 route 结论', async () => {
    await seedKnowledge();
    await seedQuestion(['kc-1']);
    await seedMastery('kc-1', 5, 1.2);
    await seedPendingClaim('kc-1', 'claim-9');
    const { deps, calls } = fakeDeps([validPlanJson([])]);

    await runSupplyPlanner(db, deps);

    const input = calls[0].input;
    expect(input.date).toBe('2026-09-12');
    expect(input.jyeoo_budget_remaining).toBe(40);
    const subjects = input.subjects as Array<{
      id: string;
      frontier: Array<{
        id: string;
        available_questions: number;
        theta: number | null;
        evidence_count: number;
      }>;
    }>;
    expect(subjects).toHaveLength(1);
    expect(subjects[0].id).toBe('math');
    const kc1 = subjects[0].frontier.find((entry) => entry.id === 'kc-1');
    if (!kc1) throw new Error('kc-1 frontier entry missing');
    expect(kc1.available_questions).toBe(1);
    expect(kc1.theta).toBeCloseTo(1.2);
    expect(kc1.evidence_count).toBe(5);
    const claims = input.pending_placement_claims as Array<{ claim_id: string }>;
    expect(claims.map((claim) => claim.claim_id)).toEqual(['claim-9']);
    // 原始信号面不含扫描器的 route/gap 结论字段
    expect(JSON.stringify(input)).not.toContain('route_preference');
  });
});
