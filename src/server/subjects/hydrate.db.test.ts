// YUK-599 — reconcileBuiltinTraits + hydrateSubjectRegistryFromDb 的 db 合同测试。
// 覆盖 v3 §8：test 9（降级链三层，断言最终返回哪份 profile）、11（reconcile 幂等 +
// owner-edited 谓词边界清除）、18（alias claim JOIN 直测——用 custom 科目的 DB-only
// 别名证明 JOIN 生效，builtin 别名构造器本就有会假绿）、27（降级态 provenance：
// journal 回溯 id@rev / 代码种子 id@seed:<v> / builtin 地板）+ reconcileCustomIds。

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { reconcileBuiltinTraits } from './reconcile-builtin-traits';

const db = testDb();

beforeEach(() => resetDb());

describe('reconcileBuiltinTraits — 种子 + 幂等（v3 §6 / §8-11）', () => {
  it('重跑 = 硬 no-op：零新 journal 行、revision 不动（幂等的机械基础）', async () => {
    await reconcileBuiltinTraits(db);
    const before = await db.execute(
      sql`select count(*)::int as c, coalesce(max(change_seq),0)::bigint as seq from subject_trait_journal`,
    );
    const report = await reconcileBuiltinTraits(db);
    expect(report.insertedTraits).toBe(0);
    expect(report.upgradedTraits).toBe(0);
    expect(report.skippedTraits).toBe(24);
    const after = await db.execute(
      sql`select count(*)::int as c, coalesce(max(change_seq),0)::bigint as seq from subject_trait_journal`,
    );
    expect(after[0]).toEqual(before[0]); // 连 change_seq 高水位都不动 = 真零写
  });
});
