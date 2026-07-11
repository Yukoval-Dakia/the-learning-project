// YUK-601 (v3.2 §3.1-§3.3 + §3.4 reset-to-seed) — trait 域写面合同测试。
// 对照 §8 验收编号：2（共享传播）3（fan-out 422 零残留）5（rollback-forward）
// 6（CAS stale）14（换绑 + kind 匹配）22（reset-to-seed）24（general 锁定）
// 25（deep-equal no-op）26（外国种子 COW：custom 借 general 种子编辑 → 自动
// fork，来源血统不动）。

import {
  subject,
  subject_control_journal,
  subject_trait,
  subject_trait_binding,
  subject_trait_journal,
} from '@/db/schema';
import { isGeneralFallbackFor } from '@/server/subjects/resolution-cache';
import { count, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { hydrateSubjectRegistryFromDb } from './hydrate';
import { reconcileBuiltinTraits } from './reconcile-builtin-traits';
import { thinCreateSubject } from './thin-create';
import {
  editSharedTrait,
  editSubjectTrait,
  forkSubjectTrait,
  rebindSubjectTrait,
  resetTraitToSeed,
  rollbackTrait,
} from './trait-write';

const db = testDb();

async function createCustom(displayName = '化学'): Promise<string> {
  const result = await thinCreateSubject(db, displayName);
  if (result.kind !== 'created') throw new Error(`thin-create failed: ${result.kind}`);
  return result.payload.id;
}

async function traitRow(traitId: string) {
  const rows = await db.select().from(subject_trait).where(eq(subject_trait.id, traitId));
  return rows[0];
}

async function boundTraitId(subjectId: string, kind: string): Promise<string> {
  const rows = await db
    .select({ traitId: subject_trait_binding.trait_id })
    .from(subject_trait_binding)
    .where(eq(subject_trait_binding.subject_id, subjectId));
  const hit = rows.length;
  const all = await db
    .select()
    .from(subject_trait_binding)
    .where(eq(subject_trait_binding.subject_id, subjectId));
  const row = all.find((b) => b.trait_kind === kind);
  if (!row) throw new Error(`no ${kind} binding for ${subjectId} (${hit} rows)`);
  return row.trait_id;
}

async function traitCount(): Promise<number> {
  const rows = await db.select({ n: count() }).from(subject_trait);
  return rows[0]?.n ?? 0;
}

function charterWith(base: unknown, methodology: string): unknown {
  return { ...(base as Record<string, unknown>), methodology };
}

beforeEach(async () => {
  await resetDb();
  await reconcileBuiltinTraits(db);
  await hydrateSubjectRegistryFromDb(db);
});

describe('editSubjectTrait — 主写面（自动 COW，§8-26/25/6/3）', () => {
  it('custom 编辑借绑的 general 种子 → 同事务 fork-and-edit，来源血统不动（§8-26）', async () => {
    const id = await createCustom();
    const seed = await traitRow('trt_seed_general_charter');
    const before = await traitCount();

    const result = await editSubjectTrait(db, {
      subjectId: id,
      kind: 'charter',
      expectedSubjectRevision: 0,
      expectedTraitRevision: seed.revision,
      payload: charterWith(seed.payload, '先讲原理再做题'),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.forked).toBe(true);
    expect(result.traitId).toMatch(/^trt_/);
    expect(result.revision).toBe(1);

    // 新 trait：owner=本科、origin custom、无种子血统。
    const forked = await traitRow(result.traitId);
    expect(forked).toMatchObject({ owner_subject_id: id, origin: 'custom', seed_version: null });
    expect(await traitCount()).toBe(before + 1);
    // journal rev0 fork_source（来源快照 + 血统指针）+ rev1 edit。
    const journal = await db
      .select()
      .from(subject_trait_journal)
      .where(eq(subject_trait_journal.trait_id, result.traitId));
    expect(journal.map((j) => [j.revision, j.action])).toEqual([
      [0, 'fork_source'],
      [1, 'edit'],
    ]);
    expect(journal[0]).toMatchObject({
      source_trait_id: 'trt_seed_general_charter',
      source_revision: seed.revision,
    });
    // 绑定改指 fork；来源种子 payload/revision 未动（外科永不暗改，math/general 血统安全）。
    expect(await boundTraitId(id, 'charter')).toBe(result.traitId);
    const seedAfter = await traitRow('trt_seed_general_charter');
    expect(seedAfter.revision).toBe(seed.revision);
    expect(seedAfter.payload).toEqual(seed.payload);
    // subject.revision+1 + control journal 'fork'。
    const subjectRow = (await db.select().from(subject).where(eq(subject.id, id)))[0];
    expect(subjectRow?.revision).toBe(1);
    const cj = await db
      .select()
      .from(subject_control_journal)
      .where(eq(subject_control_journal.subject_id, id));
    expect(cj.map((j) => j.action)).toContain('fork');
    // 派生翻 false（任一 fork 后）。
    await hydrateSubjectRegistryFromDb(db);
    expect(isGeneralFallbackFor(id)).toBe(false);
  });

  it('deep-equal no-op：提交未修改的表单 → 200 noop，零 fork 零 journal 零 bump（§8-25）', async () => {
    const id = await createCustom();
    const seed = await traitRow('trt_seed_general_charter');
    const before = await traitCount();
    const result = await editSubjectTrait(db, {
      subjectId: id,
      kind: 'charter',
      expectedSubjectRevision: 0,
      expectedTraitRevision: seed.revision,
      payload: seed.payload,
    });
    expect(result.kind).toBe('noop');
    expect(await traitCount()).toBe(before);
    const subjectRow = (await db.select().from(subject).where(eq(subject.id, id)))[0];
    expect(subjectRow?.revision).toBe(0);
    await hydrateSubjectRegistryFromDb(db);
    expect(isGeneralFallbackFor(id)).toBe(true);
  });

  it('CAS：expectedTraitRevision 陈旧 → stale 携 currentRevision（§8-6）', async () => {
    const id = await createCustom();
    const seed = await traitRow('trt_seed_general_charter');
    const result = await editSubjectTrait(db, {
      subjectId: id,
      kind: 'charter',
      expectedSubjectRevision: 0,
      expectedTraitRevision: seed.revision + 5,
      payload: charterWith(seed.payload, 'x'),
    });
    expect(result).toMatchObject({ kind: 'stale', currentRevision: seed.revision, axis: 'trait' });
  });

  it('CAS：expectedSubjectRevision 陈旧 → stale 走 subject 轴（§8-6，review-765 P3）', async () => {
    const id = await createCustom();
    const seed = await traitRow('trt_seed_general_charter');
    const result = await editSubjectTrait(db, {
      subjectId: id,
      kind: 'charter',
      expectedSubjectRevision: 9,
      expectedTraitRevision: seed.revision,
      payload: charterWith(seed.payload, 'x'),
    });
    expect(result).toMatchObject({ kind: 'stale', currentRevision: 0, axis: 'subject' });
  });

  it('共享写 fan-out 多科回显：两 custom 同绑 general 种子，坏 payload 逐科列出（§8-4）', async () => {
    const a = await createCustom('化学');
    const b = await createCustom('生物');
    const seed = await traitRow('trt_seed_general_judge_policy');
    const result = await editSharedTrait(db, {
      traitId: seed.id,
      expectedRevision: seed.revision,
      payload: {
        ...(seed.payload as Record<string, unknown>),
        judgeCapabilities: ['judge_phantom_nope'],
      },
    });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    const subjects = (result.issues ?? []).map((i) => i.subjectId);
    expect(subjects).toEqual(expect.arrayContaining(['general', a, b]));
  });

  it('fan-out 422：幻 judge id 过 strict parse 被装配校验拒，零残留（§8-3/4）', async () => {
    const id = await createCustom();
    const seed = await traitRow('trt_seed_general_judge_policy');
    const before = await traitCount();
    const bad = {
      ...(seed.payload as Record<string, unknown>),
      judgeCapabilities: ['judge_phantom_nope'],
    };
    const result = await editSubjectTrait(db, {
      subjectId: id,
      kind: 'judge_policy',
      expectedSubjectRevision: 0,
      expectedTraitRevision: seed.revision,
      payload: bad,
    });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.issues?.[0]?.subjectId).toBe(id);
    // 零残留：无新 trait 行、绑定未动、subject.revision 未 bump。
    expect(await traitCount()).toBe(before);
    expect(await boundTraitId(id, 'judge_policy')).toBe('trt_seed_general_judge_policy');
    const subjectRow = (await db.select().from(subject).where(eq(subject.id, id)))[0];
    expect(subjectRow?.revision).toBe(0);
  });

  it('general 自有种子原地写 + 全绑定者跟随（§8-2/24）', async () => {
    const id = await createCustom();
    const seed = await traitRow('trt_seed_general_charter');
    const result = await editSubjectTrait(db, {
      subjectId: 'general',
      kind: 'charter',
      expectedSubjectRevision: 0,
      expectedTraitRevision: seed.revision,
      payload: charterWith(seed.payload, '通用方法论 v2'),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.forked).toBe(false);
    expect(result.traitId).toBe('trt_seed_general_charter');
    // 未 fork 的 custom 仍活跟随（绑定不动 → 读到新 payload；badge 语义诚实）。
    expect(await boundTraitId(id, 'charter')).toBe('trt_seed_general_charter');
    await hydrateSubjectRegistryFromDb(db);
    expect(isGeneralFallbackFor(id)).toBe(true);
    const journal = await db
      .select()
      .from(subject_trait_journal)
      .where(eq(subject_trait_journal.trait_id, 'trt_seed_general_charter'));
    expect(journal.at(-1)).toMatchObject({ action: 'edit', actor: 'owner', revision: 1 });
  });
});

describe('editSharedTrait / rollback / reset-to-seed（§8-2/5/22）', () => {
  it('显式共享写 bump 种子 revision + journal edit（§8-2）', async () => {
    const seed = await traitRow('trt_seed_general_charter');
    const result = await editSharedTrait(db, {
      traitId: seed.id,
      expectedRevision: seed.revision,
      payload: charterWith(seed.payload, '共享面改写'),
    });
    expect(result).toMatchObject({ kind: 'ok', traitId: seed.id, revision: seed.revision + 1 });
    const after = await traitRow(seed.id);
    expect((after.payload as { methodology: string }).methodology).toBe('共享面改写');
    expect(after.seed_version).toBe(seed.seed_version);
  });

  it('rollback-forward：恢复目标内容为新 revision，血统不动（§8-5）', async () => {
    const seed = await traitRow('trt_seed_general_charter');
    await editSharedTrait(db, {
      traitId: seed.id,
      expectedRevision: 0,
      payload: charterWith(seed.payload, '第一次编辑'),
    });
    const result = await rollbackTrait(db, {
      traitId: seed.id,
      expectedRevision: 1,
      targetRevision: 0,
    });
    expect(result).toMatchObject({ kind: 'ok', revision: 2 });
    const after = await traitRow(seed.id);
    expect(after.payload).toEqual(seed.payload); // 内容回 rev0
    expect(after.revision).toBe(2); // git-revert 非 git-reset
    expect(after.seed_version).toBe(seed.seed_version); // lineage 不动
    const journal = await db
      .select()
      .from(subject_trait_journal)
      .where(eq(subject_trait_journal.trait_id, seed.id));
    expect(journal.at(-1)).toMatchObject({ action: 'rollback', rolled_back_from: 0, revision: 2 });
  });

  it('rollback：targetRevision 不在 journal → invalid（review-765 P3）', async () => {
    const seed = await traitRow('trt_seed_general_charter');
    const result = await rollbackTrait(db, {
      traitId: seed.id,
      expectedRevision: seed.revision,
      targetRevision: 42,
    });
    expect(result.kind).toBe('invalid');
  });

  it('reset-to-seed：编辑过的种子恢复出厂 + seed_version 对齐；非种子行拒绝（§8-22）', async () => {
    const seed = await traitRow('trt_seed_general_charter');
    await editSharedTrait(db, {
      traitId: seed.id,
      expectedRevision: 0,
      payload: charterWith(seed.payload, '被 owner 改过'),
    });
    const result = await resetTraitToSeed(db, { traitId: seed.id, expectedRevision: 1 });
    expect(result).toMatchObject({ kind: 'ok', revision: 2 });
    const after = await traitRow(seed.id);
    expect(after.payload).toEqual(seed.payload);
    expect(after.seed_version).toBe(seed.seed_version);

    // 非种子（fork 行）→ invalid。
    const id = await createCustom();
    const fork = await forkSubjectTrait(db, {
      subjectId: id,
      kind: 'charter',
      expectedSubjectRevision: 0,
    });
    expect(fork.kind).toBe('ok');
    if (fork.kind !== 'ok') return;
    const denied = await resetTraitToSeed(db, { traitId: fork.traitId, expectedRevision: 0 });
    expect(denied.kind).toBe('invalid');
  });
});

describe('fork / rebind（§8-14/23/24）', () => {
  it('显式 fork：rev0 快照复制 + 绑定改指 + control journal（§8-23 fork 变 version 身份）', async () => {
    const id = await createCustom();
    const seed = await traitRow('trt_seed_general_charter');
    const result = await forkSubjectTrait(db, {
      subjectId: id,
      kind: 'charter',
      expectedSubjectRevision: 0,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.revision).toBe(0);
    const forked = await traitRow(result.traitId);
    expect(forked.payload).toEqual(seed.payload);
    expect(forked.owner_subject_id).toBe(id);
    expect(await boundTraitId(id, 'charter')).toBe(result.traitId);
    const journal = await db
      .select()
      .from(subject_trait_journal)
      .where(eq(subject_trait_journal.trait_id, result.traitId));
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ action: 'fork_source', source_trait_id: seed.id });
  });

  it('换绑「化学借数学的 judge_policy」：control journal rebind + isGeneralFallback 翻 false（§8-14）', async () => {
    const id = await createCustom();
    const result = await rebindSubjectTrait(db, {
      subjectId: id,
      kind: 'judge_policy',
      targetTraitId: 'trt_seed_math_judge_policy',
      expectedSubjectRevision: 0,
    });
    expect(result.kind).toBe('ok');
    expect(await boundTraitId(id, 'judge_policy')).toBe('trt_seed_math_judge_policy');
    const cj = await db
      .select()
      .from(subject_control_journal)
      .where(eq(subject_control_journal.subject_id, id));
    const rebind = cj.find((j) => j.action === 'rebind');
    expect(rebind?.detail).toMatchObject({
      kind: 'judge_policy',
      from_trait_id: 'trt_seed_general_judge_policy',
      to_trait_id: 'trt_seed_math_judge_policy',
    });
    await hydrateSubjectRegistryFromDb(db);
    expect(isGeneralFallbackFor(id)).toBe(false);
  });

  it('kind 不匹配 → invalid；general fork/rebind → forbidden（§8-14/24）', async () => {
    const id = await createCustom();
    const mismatch = await rebindSubjectTrait(db, {
      subjectId: id,
      kind: 'judge_policy',
      targetTraitId: 'trt_seed_math_charter',
      expectedSubjectRevision: 0,
    });
    expect(mismatch.kind).toBe('invalid');

    expect(
      (
        await forkSubjectTrait(db, {
          subjectId: 'general',
          kind: 'charter',
          expectedSubjectRevision: 0,
        })
      ).kind,
    ).toBe('forbidden');
    expect(
      (
        await rebindSubjectTrait(db, {
          subjectId: 'general',
          kind: 'charter',
          targetTraitId: 'trt_seed_math_charter',
          expectedSubjectRevision: 0,
        })
      ).kind,
    ).toBe('forbidden');
  });
});
