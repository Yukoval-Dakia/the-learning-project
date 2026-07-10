// YUK-599 — reconcileBuiltinTraits + hydrateSubjectRegistryFromDb 的 db 合同测试。
// 覆盖 v3 §8：test 9（降级链三层，断言最终返回哪份 profile）、11（reconcile 幂等 +
// owner-edited 谓词边界清除）、18（alias claim JOIN 直测——用 custom 科目的 DB-only
// 别名证明 JOIN 生效，builtin 别名构造器本就有会假绿）、27（降级态 provenance：
// journal 回溯 id@rev / 代码种子 id@seed:<v> / builtin 地板）+ reconcileCustomIds。

import { subject, subject_name_claim, subject_trait, subject_trait_binding } from '@/db/schema';
import {
  BUILTIN_SUBJECT_IDS,
  BUILTIN_TRAIT_SEEDS,
  seedTraitId,
} from '@/subjects/builtin-trait-seeds';
import { SubjectRegistry, subjectProfiles } from '@/subjects/profile';
import { SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';
import { count, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { getSubjectTraitResolutions, hydrateSubjectRegistryFromDb } from './hydrate';
import { reconcileBuiltinTraits } from './reconcile-builtin-traits';

const db = testDb();

beforeEach(() => resetDb());

describe('reconcileBuiltinTraits — 种子 + 幂等（v3 §6 / §8-11）', () => {
  it('fresh DB：4 subject + 24 trait（journal rev-0 全带）+ 24 绑定 + claims 全落', async () => {
    const report = await reconcileBuiltinTraits(db);
    expect(report.insertedSubjects).toBe(4);
    expect(report.insertedTraits).toBe(24);
    expect(report.skippedTraits).toBe(0);

    const subjects = await db.select().from(subject);
    expect(subjects).toHaveLength(4);
    const general = subjects.find((s) => s.id === 'general');
    expect(general?.is_selectable).toBe(false); // 结构性排除（v2 §2.1）
    expect(subjects.find((s) => s.id === 'yuwen')?.is_selectable).toBe(true);

    const [{ traits }] = await db.select({ traits: count() }).from(subject_trait);
    expect(traits).toBe(24);
    const [{ bindings }] = await db.select({ bindings: count() }).from(subject_trait_binding);
    expect(bindings).toBe(24);
    // 通则：一切 trait 创建路径必须写 rev-0 journal 行（action=create，actor=migrate）。
    const journal = await db.execute(
      sql`select count(*)::int as c from subject_trait_journal where revision = 0 and action = 'create' and actor = 'migrate'`,
    );
    expect(journal[0]?.c).toBe(24);
    // claims：canonical ×4 + builtin 别名 ×6（yuwen 3 + math 2 + physics 1）。
    const claims = await db.execute(
      sql`select kind, count(*)::int as c from subject_name_claim group by kind order by kind`,
    );
    expect(claims).toEqual([
      { kind: 'alias', c: 6 },
      { kind: 'canonical', c: 4 },
    ]);
  });

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

  it('seed_version 漂移 → 覆盖升级 + journal reconcile；owner 编辑 → 保留；reset_to_seed 后恢复送达（§8-11 谓词边界）', async () => {
    await reconcileBuiltinTraits(db);
    const traitId = seedTraitId('yuwen', 'charter');

    // ① 模拟旧行（行 seed_version 落后代码种子）→ 升级送达。
    await db
      .update(subject_trait)
      .set({ seed_version: '0.9.0' })
      .where(eq(subject_trait.id, traitId));
    let report = await reconcileBuiltinTraits(db);
    expect(report.upgradedTraits).toBe(1);
    const [row1] = await db.select().from(subject_trait).where(eq(subject_trait.id, traitId));
    expect(row1.seed_version).toBe(BUILTIN_TRAIT_SEEDS.yuwen.charter.seedVersion);
    expect(row1.revision).toBe(1);
    const journal1 = await db.execute(
      sql`select action, actor from subject_trait_journal where trait_id = ${traitId} and revision = 1`,
    );
    expect(journal1[0]).toEqual({ action: 'reconcile', actor: 'migrate' });

    // ② owner 编辑（journal actor='owner' 行 > 边界）→ 升级被扣留。
    await db.execute(
      sql`insert into subject_trait_journal (trait_id, revision, payload, payload_schema_version, seed_version, action, actor, created_at)
          select ${traitId}, 2, payload, payload_schema_version, seed_version, 'edit', 'owner', now() from subject_trait where id = ${traitId}`,
    );
    await db
      .update(subject_trait)
      .set({ revision: 2, seed_version: '0.5.0' })
      .where(eq(subject_trait.id, traitId));
    report = await reconcileBuiltinTraits(db);
    expect(report.preservedTraits).toBe(1);
    expect(report.upgradedTraits).toBe(0);

    // ③ reset_to_seed（新边界，严格大于号自排除）→ 谓词翻回未编辑，升级恢复送达。
    await db.execute(
      sql`insert into subject_trait_journal (trait_id, revision, payload, payload_schema_version, seed_version, action, actor, created_at)
          select ${traitId}, 3, payload, payload_schema_version, seed_version, 'reset_to_seed', 'owner', now() from subject_trait where id = ${traitId}`,
    );
    await db
      .update(subject_trait)
      .set({ revision: 3, seed_version: '0.5.0' })
      .where(eq(subject_trait.id, traitId));
    report = await reconcileBuiltinTraits(db);
    expect(report.upgradedTraits).toBe(1);
    expect(report.preservedTraits).toBe(0);
  });
});

describe('hydrateSubjectRegistryFromDb — 装配 + alias + 防御网', () => {
  it('DB 装配的 builtin 与代码 profile 逐字段等价（version = jt: 身份串例外）', async () => {
    await reconcileBuiltinTraits(db);
    const registry = new SubjectRegistry();
    const report = await hydrateSubjectRegistryFromDb(db, registry);
    expect(report.hydrated).toEqual(
      expect.arrayContaining(['general', 'yuwen', 'math', 'physics']),
    );

    const assembled = registry.get('yuwen');
    const code = subjectProfiles.yuwen;
    expect(assembled).toBeDefined();
    if (!assembled || !code) return;
    const { version: av, ...aRest } = assembled;
    const { version: _cv, ...cRest } = code;
    expect(aRest).toEqual(cRest); // 零行为变化基线的 DB 半（v3 §8-13 口径）
    expect(av).toBe(
      `jt:${seedTraitId('yuwen', 'charter')}@0;${seedTraitId('yuwen', 'judge_policy')}@0;${seedTraitId('yuwen', 'cause_taxonomy')}@0;${seedTraitId('yuwen', 'source_policy')}@0`,
    );
  });

  it('alias claim JOIN 直测（§8-18）：custom 科目的 DB-only 别名水合后可解析', async () => {
    await reconcileBuiltinTraits(db);
    const now = new Date();
    await db.insert(subject).values({
      id: 'subj_testcustom1',
      display_name: '化学',
      display_name_norm: '化学',
      origin: 'custom',
      is_selectable: true,
      retired_at: null,
      revision: 0,
      created_at: now,
      updated_at: now,
    });
    for (const kind of SUBJECT_TRAIT_KINDS) {
      await db.insert(subject_trait_binding).values({
        subject_id: 'subj_testcustom1',
        trait_kind: kind,
        trait_id: seedTraitId('general', kind), // thin-create 语义：绑 general 种子
      });
    }
    await db.insert(subject_name_claim).values([
      { name_norm: '化学', subject_id: 'subj_testcustom1', kind: 'canonical', created_at: now },
      { name_norm: 'chemistry', subject_id: 'subj_testcustom1', kind: 'alias', created_at: now },
    ]);

    const registry = new SubjectRegistry();
    expect(registry.resolveKnownSubjectId('chemistry')).toBeNull(); // 构造器不知道它
    await hydrateSubjectRegistryFromDb(db, registry);
    expect(registry.resolveKnownSubjectId('chemistry')).toBe('subj_testcustom1'); // JOIN 生效
    expect(registry.get('subj_testcustom1')?.displayName).toBe('化学');
    // KILL-1 修复落点：custom id 进 registry，自别名成员资格成立。
    expect(registry.resolveKnownSubjectId('subj_testcustom1')).toBe('subj_testcustom1');
  });

  it('降级链②（§8-9/27）：live 坏行 → journal 回溯最近合法快照，version 用 effective rev', async () => {
    await reconcileBuiltinTraits(db);
    const traitId = seedTraitId('yuwen', 'charter');
    // 先造出 rev1 合法快照（升级路径），再打坏 live。
    await db
      .update(subject_trait)
      .set({ seed_version: '0.9.0' })
      .where(eq(subject_trait.id, traitId));
    await reconcileBuiltinTraits(db); // → rev1 + journal rev-1 快照
    await db
      .update(subject_trait)
      .set({ payload: { corrupted: true }, revision: 5 }) // 坏行 + 假高 rev
      .where(eq(subject_trait.id, traitId));

    const registry = new SubjectRegistry();
    await hydrateSubjectRegistryFromDb(db, registry);
    const assembled = registry.get('yuwen');
    // 最终返回 = journal rev-1 快照（== 当前代码种子内容），非坏行、非缺席。
    expect(assembled?.languageStyle).toBe(subjectProfiles.yuwen?.languageStyle);
    // provenance：version 指向实际采用的 rev1，不是坏行的 rev5（owner R2-P1）。
    expect(assembled?.version).toContain(`${traitId}@1;`);
    const res = getSubjectTraitResolutions().get('yuwen');
    const charterRes = res?.find((r) => r.kind === 'charter');
    expect(charterRes?.degraded).toBe('journal_fallback');
    expect(charterRes?.effective).toBe(1);
    expect(charterRes?.liveRevision).toBe(5);
  });

  it('降级链③（§8-9/27）：journal 清空 → 种子 trait 回代码种子，version 用合成身份 id@seed:<v>', async () => {
    await reconcileBuiltinTraits(db);
    const traitId = seedTraitId('math', 'judge_policy');
    await db.execute(sql`delete from subject_trait_journal where trait_id = ${traitId}`);
    await db
      .update(subject_trait)
      .set({ payload: { corrupted: true } })
      .where(eq(subject_trait.id, traitId));

    const registry = new SubjectRegistry();
    await hydrateSubjectRegistryFromDb(db, registry);
    const assembled = registry.get('math');
    expect(assembled?.judgePolicy).toEqual(subjectProfiles.math?.judgePolicy); // == 代码种子
    expect(assembled?.version).toContain(
      `${traitId}@seed:${BUILTIN_TRAIT_SEEDS.math.judge_policy.seedVersion}`,
    );
    const res = getSubjectTraitResolutions().get('math');
    expect(res?.find((r) => r.kind === 'judge_policy')?.degraded).toBe('code_seed');
  });

  it('builtin 地板（§8-27）：绑定的 custom trait 坏死 → 整科显式回 import-time 代码 profile', async () => {
    await reconcileBuiltinTraits(db);
    const now = new Date();
    // yuwen 的 charter 换绑到一个坏死 custom trait（坏 payload、无 journal、无种子血统）。
    await db.insert(subject_trait).values({
      id: 'trt_deadcustom1',
      trait_kind: 'charter',
      origin: 'custom',
      payload: { corrupted: true },
      payload_schema_version: 1,
      seed_version: null,
      owner_subject_id: 'yuwen',
      revision: 0,
      created_at: now,
      updated_at: now,
    });
    await db
      .update(subject_trait_binding)
      .set({ trait_id: 'trt_deadcustom1' })
      .where(sql`subject_id = 'yuwen' and trait_kind = 'charter'`);

    const registry = new SubjectRegistry();
    const report = await hydrateSubjectRegistryFromDb(db, registry);
    expect(report.builtinFloor).toContain('yuwen');
    // 地板断言：整科 == import-time 代码 profile（含原 version '1.0.0'，非 jt: 串）。
    expect(registry.get('yuwen')).toEqual(subjectProfiles.yuwen);
    // 其余科目照常装配。
    expect(registry.get('math')?.version).toMatch(/^jt:/);
  });

  it('custom trait 坏死 → custom 科目本轮缺席（fresh registry 无此科），builtin 不受影响', async () => {
    await reconcileBuiltinTraits(db);
    const now = new Date();
    await db.insert(subject).values({
      id: 'subj_testdead1',
      display_name: '坏科',
      display_name_norm: '坏科',
      origin: 'custom',
      is_selectable: true,
      retired_at: null,
      revision: 0,
      created_at: now,
      updated_at: now,
    });
    await db.insert(subject_trait).values({
      id: 'trt_deadcustom2',
      trait_kind: 'charter',
      origin: 'custom',
      payload: { corrupted: true },
      payload_schema_version: 1,
      seed_version: null,
      owner_subject_id: 'subj_testdead1',
      revision: 0,
      created_at: now,
      updated_at: now,
    });
    for (const kind of SUBJECT_TRAIT_KINDS) {
      await db.insert(subject_trait_binding).values({
        subject_id: 'subj_testdead1',
        trait_kind: kind,
        trait_id: kind === 'charter' ? 'trt_deadcustom2' : seedTraitId('general', kind),
      });
    }

    const registry = new SubjectRegistry();
    const report = await hydrateSubjectRegistryFromDb(db, registry);
    expect(report.skipped.map((s) => s.subjectId)).toContain('subj_testdead1');
    expect(registry.get('subj_testdead1')).toBeUndefined();
    expect(report.hydrated).toEqual(expect.arrayContaining([...BUILTIN_SUBJECT_IDS]));
  });

  it('reconcileCustomIds 防御网：DB 行集收缩 → 内存 custom 摘除，builtin 永不摘', async () => {
    await reconcileBuiltinTraits(db);
    const now = new Date();
    await db.insert(subject).values({
      id: 'subj_testgone1',
      display_name: '短命',
      display_name_norm: '短命',
      origin: 'custom',
      is_selectable: true,
      retired_at: null,
      revision: 0,
      created_at: now,
      updated_at: now,
    });
    for (const kind of SUBJECT_TRAIT_KINDS) {
      await db.insert(subject_trait_binding).values({
        subject_id: 'subj_testgone1',
        trait_kind: kind,
        trait_id: seedTraitId('general', kind),
      });
    }
    const registry = new SubjectRegistry();
    await hydrateSubjectRegistryFromDb(db, registry);
    expect(registry.get('subj_testgone1')).toBeDefined();

    // 模拟 restore 收缩行集。
    await db.execute(sql`delete from subject_trait_binding where subject_id = 'subj_testgone1'`);
    await db.execute(sql`delete from subject where id = 'subj_testgone1'`);
    const report = await hydrateSubjectRegistryFromDb(db, registry);
    expect(report.removed).toContain('subj_testgone1');
    expect(registry.get('subj_testgone1')).toBeUndefined();
    for (const sid of BUILTIN_SUBJECT_IDS) {
      expect(registry.get(sid)).toBeDefined();
    }
  });

  it('never-throws：六表缺席（模拟 42P01）→ WARN + 空 report，registry 保持代码地板', async () => {
    // 不建种子、直接把表删掉再水合（fresh fork 库有表——用改名模拟缺席后还原）。
    await db.execute(sql`alter table "subject" rename to "subject__hidden"`);
    try {
      const registry = new SubjectRegistry();
      const report = await hydrateSubjectRegistryFromDb(db, registry);
      expect(report.hydrated).toEqual([]);
      for (const sid of BUILTIN_SUBJECT_IDS) {
        expect(registry.get(sid)).toBeDefined(); // 构造器地板未被扰动
      }
    } finally {
      await db.execute(sql`alter table "subject__hidden" rename to "subject"`);
    }
  });
});
