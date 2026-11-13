// reconcileBuiltinSubjectDocs 的 db 合同测试：内置文档种子经控制面事务落表，
// 重跑必须硬 no-op——否则每次 migrate 都放大 journal 并抬高 change_seq 水位。

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_DOC_SEEDS } from '@/subjects/builtin-doc-seeds';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { reconcileBuiltinSubjectDocs } from './builtin-doc-reconcile';

const db = testDb();
const SEED_COUNT = Object.values(BUILTIN_DOC_SEEDS).flat().length;

beforeEach(() => resetDb());

describe('reconcileBuiltinSubjectDocs — 种子 + 幂等', () => {
  // @invariant data: migrate 重跑内置文档对账不得产生任何新写入——subject_doc_journal
  // 行数与 subject_change_seq 水位保持不动，历史 revision 不被重放放大。
  // @fails-if 对账改用 upsert/无条件 journal 写入、或 seed_version 比较丢失，重跑
  // 即出现新 journal 行或 change_seq 推进，断言立即变红。
  it('首跑全量落表，重跑 = 硬 no-op：零新 journal 行、change_seq 水位不动', async () => {
    const first = await reconcileBuiltinSubjectDocs(db);
    expect(first.insertedDocs).toBe(SEED_COUNT);
    const before = await db.execute(
      sql`select count(*)::int as c, coalesce(max(change_seq),0)::bigint as seq from subject_doc_journal`,
    );
    const report = await reconcileBuiltinSubjectDocs(db);
    expect(report.insertedDocs).toBe(0);
    expect(report.upgradedDocs).toBe(0);
    expect(report.skippedDocs).toBe(SEED_COUNT);
    const after = await db.execute(
      sql`select count(*)::int as c, coalesce(max(change_seq),0)::bigint as seq from subject_doc_journal`,
    );
    expect(after[0]).toEqual(before[0]); // 连 change_seq 高水位都不动 = 真零写
  });
});
