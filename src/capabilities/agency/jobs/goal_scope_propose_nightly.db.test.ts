// YUK-600 — nightly 候选源两分述的 db 合同测试（v2 §6）：
//   ① 候选源 = getSelectableSubjectIds()（custom 纳入；不再 KNOWN_SUBJECT_IDS）；
//   ② ≥5 KC gate：resolveSubjectKnowledgeIds(candidate).length >= 5 才有资格
//      ——**<5 KC 的 custom 零 LLM 调用**（验收原文）。
// runTaskFn 注入 spy：gate 挡下时必须一次都不打模型。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goal, knowledge } from '@/db/schema';
import { classifyJobYield } from '@/server/boss/job-yield';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { hydrateSubjectRegistryFromDb } from '../../../server/subjects/hydrate';
import { reconcileBuiltinTraits } from '../../../server/subjects/reconcile-builtin-traits';
import { thinCreateSubject } from '../../../server/subjects/thin-create';
import { runGoalScopeProposeNightly } from './goal_scope_propose_nightly';

const db = testDb();

beforeEach(async () => {
  await resetDb();
  await reconcileBuiltinTraits(db);
  await hydrateSubjectRegistryFromDb(db); // 清上一测试的 custom 遗留 + 上架 builtin
});

describe('goal_scope_propose_nightly — 候选源 + ≥5 KC gate（YUK-600 / v2 §6）', () => {
  it('全库只有 <5 KC 的 custom（根 1 节点）→ 零 LLM 调用、skipped_no_weak', async () => {
    const created = await thinCreateSubject(db, '化学');
    expect(created.kind).toBe('created');
    const runTaskFn = vi.fn(async () => {
      throw new Error('LLM must NOT be called for thin subjects');
    });
    const result = await runGoalScopeProposeNightly(db, { runTaskFn });
    expect(runTaskFn).not.toHaveBeenCalled(); // 验收原文：<5 KC custom 零 LLM 调用
    expect(result.proposed).toBe(0);
    expect(result.skipped_no_weak).toBe(1);
    // YUK-779: 没打模型 ⇒ 没有可失败单元被尝试。
    expect(result.llm_attempted).toBe(0);
  });

  it('候选源读活 registry：retired/摘除后的科目不再入池（selectable 谓词）', async () => {
    // builtin 三科只有根（各 1 KC）→ 同样被 ≥5 gate 挡下；无任何候选过线。
    const runTaskFn = vi.fn(async () => {
      throw new Error('no candidate should reach the LLM');
    });
    const result = await runGoalScopeProposeNightly(db, { runTaskFn });
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(result.skipped_no_weak).toBe(1);
    expect(result.llm_attempted).toBe(0);
  });
});

// ── YUK-779 (PR #1076 review) ───────────────────────────────────────────────
// gate 2 / gate 3 是唯二「`considered: 1` 但模型从未被调用」的返回路径。判据里
// attempted 必须只数**真正发生的**可失败调用，所以这两条路上 llm_attempted 必须
// 是 0 —— 否则 job 会以 {attempted:1, succeeded:1, failed:0} 上报，把一个本该是
// `idle` 的夜晚说成 `ok`，并破坏 attempted === succeeded + failed 不变量。
describe('goal_scope_propose_nightly — 前置闸命中不得计入 attempted（YUK-779）', () => {
  /** 建一个够格的候选域：≥5 KC（过 fan-out gate）且无 mastery 行（读作 0.5 → 全是 weak）。 */
  async function seedEligibleDomain(domain: string): Promise<void> {
    const now = new Date();
    await db.insert(knowledge).values(
      Array.from({ length: 6 }, (_, i) => ({
        id: `${domain}_kc_${i}`,
        name: `K-${domain}-${i}`,
        domain,
        parent_id: null,
        created_at: now,
        updated_at: now,
        version: 0,
      })),
    );
  }

  it('gate 2（该科目已有 live goal）→ considered:1 但 llm_attempted:0，零 LLM 调用', async () => {
    await seedEligibleDomain('yuwen');
    await db.insert(goal).values({
      id: 'goal_gate2',
      title: '已在飞的目标',
      subject_id: 'yuwen',
      scope_knowledge_ids: ['yuwen_kc_0'],
      scope_mode: 'explicit' as const,
      sequence_hint: 0,
      status: 'active',
      source: 'goal_scope_proposal',
      source_ref: 'p_gate2',
      created_at: new Date(),
      updated_at: new Date(),
    });

    const runTaskFn = vi.fn(async () => {
      throw new Error('gate 2 must short-circuit BEFORE the LLM half');
    });
    const result = await runGoalScopeProposeNightly(db, { runTaskFn });

    expect(runTaskFn).not.toHaveBeenCalled();
    expect(result.skipped_existing_goal).toBe(1);
    // `considered` 仍是 1（它记的是「挑到了候选域」，语义不变）……
    expect(result.considered).toBe(1);
    // ……但可失败步骤一次都没跑，所以 attempted 必须是 0。
    expect(result.llm_attempted).toBe(0);
    expect(result.llm_failed).toBe(0);

    // 端到端：这一夜必须判成 idle（正常的零产出），绝不能是 ok/stalled。
    expect(
      classifyJobYield({
        attempted: result.llm_attempted,
        succeeded: result.llm_attempted - result.llm_failed,
        failed: result.llm_failed,
      }),
    ).toBe('idle');
    // 反证：若沿用 considered 当 attempted（修前的写法），同一夜会被报成 ok。
    expect(
      classifyJobYield({
        attempted: result.considered,
        succeeded: result.considered - result.llm_failed,
        failed: result.llm_failed,
      }),
    ).toBe('ok');
  });
});
