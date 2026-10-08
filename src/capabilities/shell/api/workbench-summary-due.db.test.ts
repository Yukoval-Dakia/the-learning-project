import { beforeEach, describe, expect, it } from 'vitest';
import { loadWorkbenchSummary } from '@/capabilities/shell/public';
import type { Db } from '@/db/client';
import { knowledge, material_fsrs_state, question } from '@/db/schema';
import {
  beginTestTransaction,
  resetDb,
  rollbackTestTransaction,
  testDb,
} from '../../../../tests/helpers/db';
import { WorkbenchSummaryResponseSchema } from './contracts';
import { GET as getWorkbenchSummary } from './workbench-summary';

function scheduledState(
  subjectKind: 'question' | 'knowledge',
  subjectId: string,
  due: Date,
  now: Date,
): typeof material_fsrs_state.$inferInsert {
  return {
    id: `summary_state_${subjectId}`,
    subject_kind: subjectKind,
    subject_id: subjectId,
    due_at: due,
    state: {
      due,
      stability: 3.8,
      difficulty: 6.2,
      scheduled_days: 3,
      learning_steps: 0,
      reps: 4,
      lapses: 1,
      state: 'review',
      last_review: new Date(now.getTime() - 5 * 86_400_000),
    },
    updated_at: now,
  };
}

async function seedDuePool(db: Db, eligibleCount: number): Promise<void> {
  const now = new Date();
  const overdue = new Date(now.getTime() - 2 * 86_400_000);
  const future = new Date(now.getTime() + 7 * 86_400_000);
  await db.insert(knowledge).values([
    {
      id: 'summary_math',
      name: '二次函数的条件与反例',
      domain: 'math',
      created_at: now,
      updated_at: now,
    },
    {
      id: 'summary_physics',
      name: '控制变量与测量误差',
      domain: 'physics',
      created_at: now,
      updated_at: now,
    },
  ]);

  const eligibleQuestions = Array.from({ length: eligibleCount }, (_, index) => ({
    id: `summary_due_${String(index).padStart(3, '0')}`,
    kind: 'short_answer',
    prompt_md:
      index === 0
        ? '设二次函数 f(x)=ax²+bx+c，已知顶点位于第一象限。说明为什么不能据此断言 a>0，并给出满足条件的反例及检验过程。'
        : `第 ${index} 组实验测量中，改变导线长度后电流减小。区分观察事实与因果解释，列出需要保持不变的条件。\n\n${'分别讨论温度漂移、仪表分辨率和重复测量的影响；给出不能直接支持结论的边界情形。'.repeat(35)}`,
    reference_md:
      '先列出已知条件，再逐项检查推论；反例必须同时满足原始条件。不能把相关性直接解释为因果，也不能把一次测量视为无误差的真值。'.repeat(
        25,
      ),
    knowledge_ids: [index === 0 ? 'summary_math' : 'summary_physics'],
    source: 'manual',
    source_ref: `notebook:summary-review:${index}`,
    draft_status: index % 2 === 0 ? null : 'active',
    difficulty: (index % 5) + 1,
    metadata: {
      context: { lesson: '条件推断与证据检查', independent_work: true },
      review_notes: ['遗漏限制条件', '补充反例后再次独立检验'],
    },
    created_at: new Date(now.getTime() - 10 * 86_400_000 + index * 1000),
    updated_at: now,
  }));
  await db.insert(question).values([
    ...eligibleQuestions,
    {
      id: 'summary_future',
      kind: 'short_answer',
      prompt_md: '下周复习：说明串联电路中电流相同的适用条件及测量误差。',
      reference_md: '区分理想电路模型和仪表引入的扰动。',
      knowledge_ids: ['summary_physics'],
      source: 'manual',
      draft_status: 'active',
      created_at: now,
      updated_at: now,
    },
    {
      id: 'summary_excluded_draft',
      kind: 'short_answer',
      prompt_md: '待核验草稿：把电流减小直接归因于导线长度，忽略温度变化。',
      reference_md: '尚需核对实验控制条件，不能进入复习交付。',
      knowledge_ids: ['summary_physics'],
      source: 'manual',
      draft_status: 'draft',
      created_at: now,
      updated_at: now,
    },
  ]);
  await db.insert(material_fsrs_state).values([
    // One native knowledge projection plus historical question projections.
    // Shell checks their aggregate only; practice owns probe selection/order.
    scheduledState('knowledge', 'summary_math', overdue, now),
    ...eligibleQuestions
      .slice(1)
      .map((entry) => scheduledState('question', entry.id, overdue, now)),
    scheduledState('question', 'summary_future', future, now),
    scheduledState('question', 'summary_excluded_draft', overdue, now),
  ]);
}

async function expectSingletonEmpty(): Promise<void> {
  const response = await getWorkbenchSummary();
  expect(response.status).toBe(200);
  const summary = WorkbenchSummaryResponseSchema.parse(await response.json());
  expect(summary.kpi).toEqual({
    due_count: 0,
    pending_attribution_count: 0,
    knowledge_count: 0,
    goal_count: 0,
  });
  expect(summary.cold_start.is_empty).toBe(true);
  expect(summary.cold_start.evidence.review_due).toBe(false);
}

describe('public workbench summary due database injection', () => {
  beforeEach(resetDb);

  it.each([
    { eligibleCount: 3, expectedDueCount: 3 },
    { eligibleCount: 205, expectedDueCount: 200 },
  ])(
    'reads $eligibleCount uncommitted eligible entries with due KPI $expectedDueCount',
    async ({ eligibleCount, expectedDueCount }) => {
      await beginTestTransaction();
      try {
        const injectedDb: Db = testDb();
        await seedDuePool(injectedDb, eligibleCount);
        expect(await injectedDb.select().from(question)).toHaveLength(eligibleCount + 2);
        expect(await injectedDb.select().from(material_fsrs_state)).toHaveLength(eligibleCount + 2);
        expect(await injectedDb.select().from(knowledge)).toHaveLength(2);

        // The HTTP singleton cannot see fixtures on the reserved connection.
        await expectSingletonEmpty();
        const summary = await loadWorkbenchSummary(injectedDb);
        expect(WorkbenchSummaryResponseSchema.parse(summary)).toEqual(summary);
        expect.soft(summary.kpi.due_count).toBe(expectedDueCount);
        expect.soft(summary.cold_start.evidence.review_due).toBe(true);
        expect(summary.kpi.knowledge_count).toBe(2);
        expect(summary.cold_start).toMatchObject({
          is_empty: false,
          evidence: { knowledge: true, question: true },
        });
      } finally {
        await rollbackTestTransaction();
      }

      expect(await testDb().select().from(question)).toHaveLength(0);
      expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
      expect(await testDb().select().from(knowledge)).toHaveLength(0);
      await expectSingletonEmpty();
    },
  );
});
