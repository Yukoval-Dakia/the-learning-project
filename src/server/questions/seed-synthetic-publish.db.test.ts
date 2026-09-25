// YUK-1043（复审 P1-6）— seed-synthetic 的统一发布链 DB 测试：seed 每题铸
// 完整 revision（§2 矩阵 seeds 行「不靠审计豁免漏迁」），synthetic 答案非官方
// ⇒ withheld/unverified_rules；重复 seed 幂等（digest 不变 ⇒ 无版本 churn）。

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { question, question_group_lifecycle, question_revision } from '@/db/schema';
import { runSeed } from '../../../scripts/seed-synthetic.js';
import { resetDb, testDb } from '../../../tests/helpers/db';

describe('seed-synthetic — 统一发布（YUK-1043 P1-6）', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it('runSeed mints a first revision + withheld lifecycle for every seeded question; re-seed is idempotent', async () => {
    const db = testDb();
    await runSeed(db);

    const seeded = await db
      .select({ id: question.id })
      .from(question)
      .where(eq(question.source, 'synthetic_seed'));
    expect(seeded.length).toBeGreaterThan(0);

    const revisions = await db.select().from(question_revision);
    expect(revisions).toHaveLength(seeded.length); // 每题恰好一版
    expect(revisions.every((r) => r.revision_ordinal === 1)).toBe(true);

    const lifecycles = await db.select().from(question_group_lifecycle);
    expect(lifecycles).toHaveLength(seeded.length);
    expect(
      lifecycles.every(
        (l) =>
          l.scoring_admission_state === 'withheld' &&
          l.scoring_admission_withheld_reason === 'unverified_rules',
      ),
    ).toBe(true);

    // 幂等：重复 seed 不产生新 revision（digest 不变 ⇒ noop，无 churn）。
    await runSeed(db);
    const revisionsAfter = await db.select().from(question_revision);
    expect(revisionsAfter).toHaveLength(seeded.length);
  });
});
