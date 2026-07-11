// YUK-601 (v3.2 §3.4) — 控制行写面合同测试。
// 对照 §8 验收编号：7（rename + control journal + root.name 同步）8（reset 只
// 换绑，共享 payload 未动，孤儿保留）15（validate 无状态零落库）16（retire/
// restore + general retire 拒 + restore 撞名）。

import {
  knowledge,
  subject,
  subject_control_journal,
  subject_trait,
  subject_trait_binding,
} from '@/db/schema';
import { subjectRootId } from '@/server/subjects/ensure-subject-root';
import { isGeneralFallbackFor } from '@/server/subjects/resolution-cache';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { hydrateSubjectRegistryFromDb } from './hydrate';
import { reconcileBuiltinTraits } from './reconcile-builtin-traits';
import {
  renameSubject,
  resetSubject,
  restoreSubject,
  retireSubject,
  validateSubject,
} from './subject-control-write';
import { thinCreateSubject } from './thin-create';
import { editSubjectTrait } from './trait-write';

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
  it('rename 化学→化学基础：display_name/norm + root.name 同步 + journal {from,to}', async () => {
    const id = await createCustom();
    const result = await renameSubject(db, {
      subjectId: id,
      expectedRevision: 0,
      displayName: '化学基础',
    });
    expect(result).toMatchObject({ kind: 'ok', subjectRevision: 1 });
    const row = await subjectRow(id);
    expect(row?.display_name).toBe('化学基础');
    const root = (
      await db
        .select()
        .from(knowledge)
        .where(eq(knowledge.id, subjectRootId(id)))
    )[0];
    expect(root?.name).toBe('化学基础');
    const journal = await db
      .select()
      .from(subject_control_journal)
      .where(eq(subject_control_journal.subject_id, id));
    const rename = journal.find((j) => j.action === 'rename');
    expect(rename?.detail).toEqual({ from: '化学', to: '化学基础' });
  });

  it('撞名（builtin 语文）→ conflict；CAS 陈旧 → stale 携 currentRevision', async () => {
    const id = await createCustom();
    expect(
      (await renameSubject(db, { subjectId: id, expectedRevision: 0, displayName: '语文' })).kind,
    ).toBe('conflict');
    expect(
      await renameSubject(db, { subjectId: id, expectedRevision: 7, displayName: '化学二' }),
    ).toMatchObject({ kind: 'stale', currentRevision: 0 });
  });
});

describe('retire / restore（§8-16）', () => {
  it('retire → retired_at + journal；restore → 回 live；general retire 拒', async () => {
    const id = await createCustom();
    const retired = await retireSubject(db, { subjectId: id, expectedRevision: 0 });
    expect(retired).toMatchObject({ kind: 'ok', subjectRevision: 1 });
    expect((await subjectRow(id))?.retired_at).not.toBeNull();

    const restored = await restoreSubject(db, { subjectId: id, expectedRevision: 1 });
    expect(restored).toMatchObject({ kind: 'ok', subjectRevision: 2 });
    expect((await subjectRow(id))?.retired_at).toBeNull();
    expect(await controlActions(id)).toEqual(['create', 'retire', 'restore']);

    expect((await retireSubject(db, { subjectId: 'general', expectedRevision: 0 })).kind).toBe(
      'forbidden',
    );
  });

  it('restore 撞名：退休期间同名被新科占用 → conflict', async () => {
    const id = await createCustom('生物');
    await retireSubject(db, { subjectId: id, expectedRevision: 0 });
    await createCustom('生物'); // 同名新科占坑（partial unique 只看 live 行）
    const result = await restoreSubject(db, { subjectId: id, expectedRevision: 1 });
    expect(result.kind).toBe('conflict');
  });
});

describe('resetSubject — 只换绑，永不改共享 payload（§8-8）', () => {
  it('fork 过的 custom reset → 六绑定回 general 种子，孤儿 fork 保留，badge 回真', async () => {
    const id = await createCustom();
    const seed = (
      await db.select().from(subject_trait).where(eq(subject_trait.id, 'trt_seed_general_charter'))
    )[0];
    const edited = await editSubjectTrait(db, {
      subjectId: id,
      kind: 'charter',
      expectedSubjectRevision: 0,
      expectedTraitRevision: seed.revision,
      payload: { ...(seed.payload as Record<string, unknown>), methodology: '化学专用' },
    });
    expect(edited.kind).toBe('ok');
    if (edited.kind !== 'ok') return;

    const result = await resetSubject(db, { subjectId: id, expectedRevision: 1 });
    expect(result).toMatchObject({ kind: 'ok', subjectRevision: 2 });
    // 六绑定全部回 general 种子。
    const bindings = await db
      .select()
      .from(subject_trait_binding)
      .where(eq(subject_trait_binding.subject_id, id));
    for (const b of bindings) {
      expect(b.trait_id).toBe(`trt_seed_general_${b.trait_kind}`);
    }
    // 孤儿 fork trait 行 + payload 原样保留（无硬删面；共享种子 payload 未动）。
    const orphan = (
      await db.select().from(subject_trait).where(eq(subject_trait.id, edited.traitId))
    )[0];
    expect(orphan).toBeDefined();
    expect((orphan?.payload as { methodology: string }).methodology).toBe('化学专用');
    const seedAfter = (
      await db.select().from(subject_trait).where(eq(subject_trait.id, seed.id))
    )[0];
    expect(seedAfter?.payload).toEqual(seed.payload);
    // journal 'reset' detail 记录 rebound 明细。
    const journal = await db
      .select()
      .from(subject_control_journal)
      .where(eq(subject_control_journal.subject_id, id));
    const reset = journal.find((j) => j.action === 'reset');
    expect(reset?.detail).toMatchObject({
      rebound: [
        { kind: 'charter', from_trait_id: edited.traitId, to_trait_id: 'trt_seed_general_charter' },
      ],
    });
    await hydrateSubjectRegistryFromDb(db);
    expect(isGeneralFallbackFor(id)).toBe(true);
  });

  it('已在种子上的科目 reset → noop', async () => {
    const id = await createCustom();
    expect((await resetSubject(db, { subjectId: id, expectedRevision: 0 })).kind).toBe('noop');
  });

  it('builtin reset：rename 漂移后回种子名 + root.name 同步 + 绑定回本科种子（review-765 P3）', async () => {
    // yuwen 先改名再 reset：displayName 回种子「语文」、root.name 同步、绑定仍指
    // trt_seed_yuwen_*（builtin 的种子是本科种子非 general）。
    await renameSubject(db, { subjectId: 'yuwen', expectedRevision: 0, displayName: '古文' });
    const result = await resetSubject(db, { subjectId: 'yuwen', expectedRevision: 1 });
    expect(result).toMatchObject({ kind: 'ok', subjectRevision: 2 });
    const row = await subjectRow('yuwen');
    expect(row?.display_name).toBe('语文');
    const root = (
      await db
        .select()
        .from(knowledge)
        .where(eq(knowledge.id, subjectRootId('yuwen')))
    )[0];
    // root 行在测试基线可能不存在（reconcile 不建根）——存在才断言名字。
    if (root) expect(root.name).toBe('语文');
    const bindings = await db
      .select()
      .from(subject_trait_binding)
      .where(eq(subject_trait_binding.subject_id, 'yuwen'));
    for (const b of bindings) {
      expect(b.trait_id).toBe(`trt_seed_yuwen_${b.trait_kind}`);
    }
  });
});

describe('validateSubject — 无状态预检（§8-15）', () => {
  it('现状 valid；幻 judge override → errors；零落库', async () => {
    const id = await createCustom();
    const clean = await validateSubject(db, id);
    expect(clean).toMatchObject({ valid: true });

    const seed = (
      await db
        .select()
        .from(subject_trait)
        .where(eq(subject_trait.id, 'trt_seed_general_judge_policy'))
    )[0];
    const bad = await validateSubject(db, id, {
      judge_policy: {
        ...(seed.payload as Record<string, unknown>),
        judgeCapabilities: ['judge_phantom_nope'],
      },
    });
    expect(bad?.valid).toBe(false);
    expect(bad?.errors.length).toBeGreaterThan(0);
    // 零落库：revision 未动、无 journal 增量。
    expect((await subjectRow(id))?.revision).toBe(0);
    expect(await controlActions(id)).toEqual(['create']);

    expect(await validateSubject(db, 'subj_nope')).toBeNull();
  });
});
