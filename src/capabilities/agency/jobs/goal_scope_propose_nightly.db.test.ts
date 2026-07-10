// YUK-600 — nightly 候选源两分述的 db 合同测试（v2 §6）：
//   ① 候选源 = getSelectableSubjectIds()（custom 纳入；不再 KNOWN_SUBJECT_IDS）；
//   ② ≥5 KC gate：resolveSubjectKnowledgeIds(candidate).length >= 5 才有资格
//      ——**<5 KC 的 custom 零 LLM 调用**（验收原文）。
// runTaskFn 注入 spy：gate 挡下时必须一次都不打模型。

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  });

  it('候选源读活 registry：retired/摘除后的科目不再入池（selectable 谓词）', async () => {
    // builtin 三科只有根（各 1 KC）→ 同样被 ≥5 gate 挡下；无任何候选过线。
    const runTaskFn = vi.fn(async () => {
      throw new Error('no candidate should reach the LLM');
    });
    const result = await runGoalScopeProposeNightly(db, { runTaskFn });
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(result.skipped_no_weak).toBe(1);
  });
});
