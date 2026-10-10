// YUK-601 (v3.2 §3.4) — 控制行写面合同测试。
// 对照 §8 验收编号：7（rename + control journal + root.name 同步）8（reset 只
// 换绑，共享 payload 未动，孤儿保留）15（validate 无状态零落库）16（retire/
// restore + general retire 拒 + restore 撞名）。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedKnowledge } from '@/capabilities/knowledge/server/seed';
import { event, subject, subject_control_journal } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { hydrateSubjectRegistryFromDb } from './hydrate';
import { reconcileBuiltinTraits } from './reconcile-builtin-traits';
import { renameSubject, resetSubject } from './subject-control-write';
import { thinCreateSubject } from './thin-create';

const db = testDb();

async function createCustom(displayName = '化学'): Promise<string> {
  const result = await thinCreateSubject(db, displayName);
  if (result.kind !== 'created') throw new Error(`thin-create failed: ${result.kind}`);
  return result.payload.id;
}

async function subjectRow(id: string) {
  return (await db.select().from(subject).where(eq(subject.id, id)))[0];
}

async function controlActions(id: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(subject_control_journal)
    .where(eq(subject_control_journal.subject_id, id));
  return rows.map((r) => r.action);
}

beforeEach(async () => {
  await resetDb();
  await reconcileBuiltinTraits(db);
  await hydrateSubjectRegistryFromDb(db);
});

describe('renameSubject（§8-7）', () => {
  it('撞名（builtin 语文）→ conflict；CAS 陈旧 → stale 携 currentRevision', async () => {
    const id = await createCustom();
    expect(
      (await renameSubject(db, { subjectId: id, expectedRevision: 0, displayName: '语文' })).kind,
    ).toBe('conflict');
    expect(
      await renameSubject(db, { subjectId: id, expectedRevision: 7, displayName: '化学二' }),
    ).toMatchObject({ kind: 'stale', currentRevision: 0 });
    expect(
      await db
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:subject_root_name_update')),
    ).toHaveLength(0);
  });
});

describe('resetSubject — 只换绑，永不改共享 payload（§8-8）', () => {
  // SCF-260 / YUK-1316: builtin reset renames back to the code seed. Before the fix it skipped the
  // live-name uniqueness check the rename/restore paths use, so a custom subject holding the seed
  // name made reset create a DUPLICATE live display name. Now it returns the same 409 conflict and
  // writes nothing.
  it('builtin reset 撞名：种子名被 custom 占用 → conflict，零写入（SCF-260）', async () => {
    await seedKnowledge(db);
    // yuwen 改名漂移，种子名「语文」空出。
    await renameSubject(db, { subjectId: 'yuwen', expectedRevision: 0, displayName: '古文' });
    // custom 科占用「语文」。
    await createCustom('语文');
    const result = await resetSubject(db, { subjectId: 'yuwen', expectedRevision: 1 });
    expect(result.kind).toBe('conflict');
    const row = await subjectRow('yuwen');
    expect(row?.display_name).toBe('古文');
    expect(row?.revision).toBe(1);
    expect(await controlActions('yuwen')).toEqual(['create', 'rename']);
    // 只有 rename 写过 root.name 事件；冲突的 reset 未落任何事件。
    expect(
      await db
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:subject_root_name_update')),
    ).toHaveLength(1);
  });
});
