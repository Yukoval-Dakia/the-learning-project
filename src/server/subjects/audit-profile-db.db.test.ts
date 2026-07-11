// YUK-601 PR7 — 装配粒度漂移审计合同测试：健康基线全绿；绕 gate 直写坏一个
// 共享 trait（模拟 deprecated/幻 judge 存活装配的漂移形态）后审计标红，且
// 波及面 = 该 trait 的全部绑定科目。

import { subject_trait } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { auditProfilesFromDb, formatDbProfileAuditReport } from './audit-profile-db';
import { hydrateSubjectRegistryFromDb } from './hydrate';
import { reconcileBuiltinTraits } from './reconcile-builtin-traits';
import { thinCreateSubject } from './thin-create';

const db = testDb();

beforeEach(async () => {
  await resetDb();
  await reconcileBuiltinTraits(db);
  await hydrateSubjectRegistryFromDb(db);
});

describe('auditProfilesFromDb（YUK-601 PR7）', () => {
  it('健康基线：四 builtin + thin-create custom 全部 valid', async () => {
    const created = await thinCreateSubject(db, '化学');
    expect(created.kind).toBe('created');
    const result = await auditProfilesFromDb(db);
    expect(result.total).toBe(5);
    expect(result.valid).toBe(true);
    expect(result.invalid).toBe(0);
    expect(formatDbProfileAuditReport(result)).toContain('OK: all DB-assembled subjects validate');
  });

  it('绕 gate 直写坏共享 trait → 全部绑定科目标红（装配粒度，非行粒度）', async () => {
    const created = await thinCreateSubject(db, '化学');
    if (created.kind !== 'created') throw new Error('setup failed');
    // 模拟漂移：general judge_policy 的 judgeCapabilities 塞幻 id（绕写门直写，
    // 正是本审计存在的理由——写门外的变化只有装配审计能抓）。
    const rows = await db
      .select()
      .from(subject_trait)
      .where(eq(subject_trait.id, 'trt_seed_general_judge_policy'));
    const payload = rows[0]?.payload as Record<string, unknown>;
    await db
      .update(subject_trait)
      .set({ payload: { ...payload, judgeCapabilities: ['judge_phantom_nope'] } })
      .where(eq(subject_trait.id, 'trt_seed_general_judge_policy'));

    const result = await auditProfilesFromDb(db);
    expect(result.valid).toBe(false);
    // general + 化学 都绑该种子 → 两科都标红；builtin 三科绑自己的种子不受累。
    const invalidIds = result.entries.filter((e) => !e.valid).map((e) => e.id);
    expect(invalidIds).toEqual(expect.arrayContaining(['general', created.payload.id]));
    expect(invalidIds).not.toContain('yuwen');
    const report = formatDbProfileAuditReport(result);
    expect(report).toContain('INVALID');
    expect(report).toContain('ERROR: one or more subjects fail DB-assembly validation');
  });
});
