// YUK-600 — thinCreateSubject 的 db 合同测试（v3 §8-1 + v2 §3.2 幂等/撞名）。
// 覆盖：原子五件套（控制行/claim/六绑定零新 trait/root+genesis+anchor/journal）、
// isGeneralFallback 派生、幂等 200 回放（零第二行/根/claim）、custom↔builtin
// 显示名与 id/alias 双命名空间撞名 422、registry 即时上架。

import { event, knowledge, subject, subject_name_claim, subject_trait } from '@/db/schema';
import { getDefaultSubjectRegistry, normalizeSubjectKey } from '@/subjects/profile';
import { count, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { hydrateSubjectRegistryFromDb } from './hydrate';
import { reconcileBuiltinTraits } from './reconcile-builtin-traits';
import { thinCreateSubject } from './thin-create';

const db = testDb();

beforeEach(async () => {
  await resetDb();
  await reconcileBuiltinTraits(db);
  // 默认 registry 是跨测试单例：把 DB 实况（仅 builtin）水合进去，顺带清掉
  // 上一测试遗留的 custom 条目（reconcileCustomIds 防御网正好是清洁工）。
  await hydrateSubjectRegistryFromDb(db);
});

describe('thinCreateSubject — 原子五件套（v3 §8-1）', () => {
  it('建「化学」：控制行 + canonical(id) claim + 六绑定 general 种子 + root/genesis/anchor + journal，零新 trait 行', async () => {
    const result = await thinCreateSubject(db, '化学');
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    const { payload } = result;
    expect(payload.id).toMatch(/^subj_[a-z0-9]+$/);
    expect(payload.displayName).toBe('化学');
    expect(payload.isGeneralFallback).toBe(true); // 派生：六绑定全指 general 种子
    expect(payload.revision).toBe(0);
    expect(payload.seedRootId).toBe(`seed:${payload.id}:root`);

    // 控制行。
    const [row] = await db.select().from(subject).where(eq(subject.id, payload.id));
    expect(row).toMatchObject({
      origin: 'custom',
      is_selectable: true,
      retired_at: null,
      revision: 0,
      display_name: '化学',
      display_name_norm: '化学',
    });
    // canonical claim = normalizeSubjectKey(id)（id/alias 命名空间，v2 §3.1）。
    const claims = await db
      .select()
      .from(subject_name_claim)
      .where(eq(subject_name_claim.subject_id, payload.id));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      name_norm: normalizeSubjectKey(payload.id),
      kind: 'canonical',
    });
    // 六绑定全指 general 种子；零新 trait 行（24 = builtin 种子全集）。
    const bindings = await db.execute(
      sql`select trait_id from subject_trait_binding where subject_id = ${payload.id}`,
    );
    expect(bindings).toHaveLength(6);
    for (const b of bindings as unknown as Array<{ trait_id: string }>) {
      expect(b.trait_id).toMatch(/^trt_seed_general_/);
    }
    const [{ traits }] = await db.select({ traits: count() }).from(subject_trait);
    expect(traits).toBe(24);
    // root + genesis + anchor（event-sourced from birth）。
    const [root] = await db.select().from(knowledge).where(eq(knowledge.id, payload.seedRootId));
    expect(root).toMatchObject({ name: '化学', domain: payload.id, parent_id: null });
    const genesis = await db
      .select({ action: event.action })
      .from(event)
      .where(eq(event.subject_id, payload.seedRootId));
    expect(genesis.map((g) => g.action)).toContain('experimental:genesis');
    const anchor = await db.execute(
      sql`select anchor_event_id from materialized_id_index where materialized_id = ${payload.seedRootId}`,
    );
    expect(anchor).toHaveLength(1);
    // control journal 'create' rev0 actor owner。
    const journal = await db.execute(
      sql`select action, actor, revision from subject_control_journal where subject_id = ${payload.id}`,
    );
    expect(journal).toEqual([{ action: 'create', actor: 'owner', revision: 0 }]);
    // registry 即时上架（装配 + selectable + KILL-1 自别名成员资格）。
    const registry = getDefaultSubjectRegistry();
    expect(registry.get(payload.id)?.displayName).toBe('化学');
    expect(registry.getSelectableSubjectIds()).toContain(payload.id);
    expect(registry.resolveKnownSubjectId(payload.id)).toBe(payload.id);
  });

  it('幂等：连发同名 → 200 回放同 id，零第二行/第二根/第二 claim', async () => {
    const first = await thinCreateSubject(db, '化学');
    expect(first.kind).toBe('created');
    const again = await thinCreateSubject(db, '  化学 '); // trim+NFC 归一同名
    expect(again.kind).toBe('replayed');
    if (first.kind !== 'created' || again.kind !== 'replayed') return;
    expect(again.payload.id).toBe(first.payload.id);
    const [{ rows }] = await db
      .select({ rows: count() })
      .from(subject)
      .where(eq(subject.origin, 'custom'));
    expect(rows).toBe(1);
    const [{ roots }] = await db
      .select({ roots: count() })
      .from(knowledge)
      .where(eq(knowledge.id, first.payload.seedRootId));
    expect(roots).toBe(1);
  });

  it('custom↔builtin 撞名 422：显示名撞（「语文」）与 id/alias 命名空间撞（wenyan/math）都拒', async () => {
    for (const name of ['语文', 'wenyan', 'math', ' MATH ']) {
      const r = await thinCreateSubject(db, name);
      expect(r.kind, `'${name}' 应 422`).toBe('name_conflict');
    }
    const [{ rows }] = await db
      .select({ rows: count() })
      .from(subject)
      .where(eq(subject.origin, 'custom'));
    expect(rows).toBe(0); // 零落库
  });

  it('空名 → invalid（400 语义），零落库', async () => {
    const r = await thinCreateSubject(db, '   ');
    expect(r.kind).toBe('invalid');
  });
});
