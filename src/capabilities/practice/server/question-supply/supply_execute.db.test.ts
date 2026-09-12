// YUK-988 (Supply-Agent/3) — supply_execute job 入口 db 测试（E3 Slice 4）。
//
// handler 是薄层（Job 解包循环 → runSupplyExecuteJobData）；测试直打执行体：
// job data zod 校验 + snake→camel 映射 + 生产 deps 并合。锁死的行为面：
//   (a) 非法 job data 响亮抛出（进 DLQ，不静默丢需求）；
//   (b) 合法 data 正确映射并执行（fake 路由 deps：web 失败回落 quiz_gen，payload
//       字段族与映射一致，executor 完成事件落库）；
//   (c) jyeoo_fetch 覆写参数透传（grade 12），缺省走 SUPPLY_EXECUTE_JYEOO_DEFAULTS。
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, knowledge } from '@/db/schema';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { SUPPLY_EXECUTE_JYEOO_DEFAULTS, runSupplyExecuteJobData } from '../../jobs/supply_execute';
import type { JyeooFetchCandidatesInput } from './jyeoo-candidates';
import {
  type ExecuteSupplyPlanDeps,
  type JyeooFetchConfig,
  type QuizGenDispatchPayload,
  type RunWebFetchCandidatesFn,
  SUPPLY_EXECUTOR_EVENT_ACTION,
} from './plan-executor';

const db = testDb();

beforeEach(() => resetDb());

const NOW = new Date('2026-09-12T12:00:00Z');

async function seedTree(): Promise<void> {
  const now = NOW;
  await db.insert(knowledge).values([
    {
      id: 'math-root',
      name: '数学',
      domain: 'math',
      parent_id: null,
      created_at: now,
      updated_at: now,
    },
    {
      id: 'kc-sets',
      name: '集合',
      domain: null,
      parent_id: 'math-root',
      created_at: now,
      updated_at: now,
    },
  ]);
}

function fakeExecutorDeps(quizGenPayloads: QuizGenDispatchPayload[]): ExecuteSupplyPlanDeps {
  const webFetch: RunWebFetchCandidatesFn = () =>
    Promise.resolve({
      status: 'failed',
      failureClass: 'tavily_unavailable',
      detail: 'TAVILY_API_KEY 未配置（测试 fake）',
    });
  return {
    runWebFetchCandidates: webFetch,
    enqueueQuizGen: (payload) => {
      quizGenPayloads.push(payload);
      return Promise.resolve('job-quizgen-1');
    },
    now: () => NOW,
  };
}

describe('runSupplyExecuteJobData（supply_execute 执行体）', () => {
  it('非法 job data 响亮抛出（payload 契约破坏进 DLQ）', async () => {
    await expect(
      runSupplyExecuteJobData(
        db,
        'job-bad',
        { plan_event_id: null, items: [] },
        fakeExecutorDeps([]),
      ),
    ).rejects.toThrow(/invalid job data/);
  });

  it('合法 data 映射执行：web 失败回落 quiz_gen，payload 字段族一致，完成事件落库', async () => {
    await seedTree();
    const quizGenPayloads: QuizGenDispatchPayload[] = [];
    const data = {
      plan_event_id: 'supply_planner_test123',
      items: [
        {
          demand_id: 'demand-1',
          knowledge_id: 'kc-sets',
          kind: 'any',
          difficulty_band: null,
          count: 3,
          route_preference: ['sourcing_web', 'quiz_gen'],
          placement_claim_id: 'claim-9',
          objective_only: true,
        },
      ],
    };

    await runSupplyExecuteJobData(db, 'job-1', data, fakeExecutorDeps(quizGenPayloads));

    // web tavily_unavailable → quiz_gen 回落；映射字段族逐一对齐
    expect(quizGenPayloads).toHaveLength(1);
    const payload = quizGenPayloads[0];
    if (!payload) throw new Error('quiz_gen payload missing');
    expect(payload.trigger).toBe('knowledge');
    expect(payload.knowledge_id).toBe('kc-sets');
    expect(payload.ref_id).toBe('kc-sets');
    expect(payload.count).toBe(3);
    expect(payload.exact_count).toBe(3);
    expect(payload.placement_starter_claim_id).toBe('claim-9');

    // executor 完成事件（幂等键写进 payload）
    const executorEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, SUPPLY_EXECUTOR_EVENT_ACTION));
    expect(executorEvents).toHaveLength(1);
    const payloadOut = executorEvents[0].payload as {
      plan_event_id: string | null;
      per_item: Array<{ routes: Array<{ route: string; status: string; skipped?: string }> }>;
    };
    expect(payloadOut.plan_event_id).toBe('supply_planner_test123');
    const routes = payloadOut.per_item[0]?.routes ?? [];
    expect(routes).toEqual([
      expect.objectContaining({
        route: 'sourcing_web',
        status: 'skipped',
        skipped: 'tavily_unavailable',
      }),
      expect.objectContaining({ route: 'quiz_gen', status: 'dispatched' }),
    ]);
  });

  it('jyeoo_fetch 覆写透传（grade 12）；缺省值 = SUPPLY_EXECUTE_JYEOO_DEFAULTS', async () => {
    await seedTree();
    const fetchInputs: Array<JyeooFetchCandidatesInput> = [];
    const deps = {
      ...fakeExecutorDeps([]),
    };
    deps.runJyeooFetchCandidates = async (params) => {
      fetchInputs.push(params.input);
      return {
        status: 'failed',
        failureClass: 'auth',
        detail: 'fake auth 失败',
        retryable: false,
        counts: {
          requested: 1,
          fetched: 0,
          validated: 0,
          invalid: 0,
          filtered_url: 0,
          filtered_kind: 0,
          filtered_band: 0,
          filtered_image: 0,
          deduped_exact: 0,
          near_dup_in_batch: 0,
          candidates: 0,
        },
        budget: { dailyBudget: 40, remainingBefore: 40, remainingAfter: 40 },
      };
    };

    await runSupplyExecuteJobData(
      db,
      'job-jyeoo',
      {
        plan_event_id: null,
        items: [
          {
            demand_id: 'demand-j',
            knowledge_id: 'kc-sets',
            kind: 'any',
            count: 1,
            route_preference: ['jyeoo_fetch'],
          },
        ],
        jyeoo_fetch: { grade: 12 },
      },
      deps,
    );
    expect(fetchInputs).toHaveLength(1);
    expect(fetchInputs[0]).toMatchObject({ grade: 12 });

    // 缺省：不带 jyeoo_fetch 的 job → SUPPLY_EXECUTE_JYEOO_DEFAULTS（grade 11 math2）
    await runSupplyExecuteJobData(
      db,
      'job-jyeoo-default',
      {
        plan_event_id: null,
        items: [
          {
            demand_id: 'demand-j2',
            knowledge_id: 'kc-sets',
            kind: 'any',
            count: 1,
            route_preference: ['jyeoo_fetch'],
          },
        ],
      },
      deps,
    );
    expect(fetchInputs).toHaveLength(2);
    expect(fetchInputs[1]).toMatchObject({
      grade: SUPPLY_EXECUTE_JYEOO_DEFAULTS.grade,
      subject: SUPPLY_EXECUTE_JYEOO_DEFAULTS.subject,
    } satisfies Partial<JyeooFetchConfig>);
  });
});
