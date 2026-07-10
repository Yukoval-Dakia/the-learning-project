// YUK-601 (v3.2 §3.5) — 管理读面合同测试（真 Postgres）。
// 场景全部从「reconcile 种 builtin + hydrate 装配」的干净基线出发，thin-create
// 一个 custom 科目后断言四个读函数 + route 壳的映射（400/404）。

import { GET as subjectTraitsRoute } from '@/capabilities/observability/api/admin-subject-traits';
import { GET as journalRoute } from '@/capabilities/observability/api/admin-trait-journal';
import { GET as traitsRoute } from '@/capabilities/observability/api/admin-traits';
import { SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  getAdminSubjectTraits,
  getTraitJournal,
  listAdminSubjects,
  listAdminTraits,
} from './admin-read';
import { hydrateSubjectRegistryFromDb } from './hydrate';
import { reconcileBuiltinTraits } from './reconcile-builtin-traits';
import { thinCreateSubject } from './thin-create';

const db = testDb();

async function createCustom(displayName = '化学'): Promise<string> {
  const result = await thinCreateSubject(db, displayName);
  if (result.kind !== 'created') throw new Error(`thin-create failed: ${result.kind}`);
  return result.payload.id;
}

beforeEach(async () => {
  await resetDb();
  await reconcileBuiltinTraits(db);
  await hydrateSubjectRegistryFromDb(db);
});

describe('listAdminSubjects — 管理枚举（全量含 general）', () => {
  it('lists builtins + general with derived flags, composed version, and subjectRevision', async () => {
    const rows = await listAdminSubjects(db);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['yuwen', 'math', 'physics', 'general']));

    const yuwen = rows.find((r) => r.id === 'yuwen');
    expect(yuwen).toMatchObject({
      origin: 'builtin',
      retiredAt: null,
      isGeneralFallback: false,
      subjectRevision: 0,
    });
    // 装配身份组合串（jt:…）——hydrate 后必须非 null（写面 CAS 初值同此端点下发）。
    expect(yuwen?.version).toMatch(/^jt:/);

    // general 自身豁免 → null（v3 §2.3）。
    expect(rows.find((r) => r.id === 'general')?.isGeneralFallback).toBeNull();
  });

  it('includes a thin-created custom subject with isGeneralFallback=true', async () => {
    const id = await createCustom();
    const row = (await listAdminSubjects(db)).find((r) => r.id === id);
    expect(row).toMatchObject({
      displayName: '化学',
      origin: 'custom',
      isGeneralFallback: true,
      subjectRevision: 0,
      retiredAt: null,
    });
    expect(row?.version).toMatch(/^jt:/);
  });
});

describe('getAdminSubjectTraits — 六绑定读面', () => {
  it('returns six bindings in kind order, all pointing at general seeds, with sharedBy', async () => {
    const id = await createCustom();
    const result = await getAdminSubjectTraits(db, id);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.subjectRevision).toBe(0);
    expect(result.bindings.map((b) => b.kind)).toEqual([...SUBJECT_TRAIT_KINDS]);
    for (const b of result.bindings) {
      expect(b.traitId).toBe(`trt_seed_general_${b.kind}`);
      expect(b.origin).toBe('builtin');
      expect(b.ownerSubjectId).toBeNull();
      expect(b.seedVersion).not.toBeNull();
      // 未降级：effective 身份 = live revision，degraded null（v3.2 分列下发）。
      expect(b.degraded).toBeNull();
      expect(b.effectiveRevision).toBe(b.revision);
      expect(b.payload).toBeTruthy();
      // general 种子被 general 自身 + 新 custom 同时绑定 → 波及面两科起步。
      expect(b.sharedBy).toEqual(expect.arrayContaining(['general', id]));
    }
  });

  it('returns null for an unknown subject; route maps it to 404', async () => {
    expect(await getAdminSubjectTraits(db, 'subj_nope')).toBeNull();
    const res = await subjectTraitsRoute(
      new Request('http://x/api/admin/subjects/subj_nope/traits'),
      {
        id: 'subj_nope',
      },
    );
    expect(res.status).toBe(404);
  });
});

describe('listAdminTraits — 跨科目录（换绑选择器）', () => {
  it('lists all charter traits with boundBy back-references', async () => {
    const id = await createCustom();
    const rows = await listAdminTraits(db, 'charter');
    const traitIds = rows.map((r) => r.traitId);
    expect(traitIds).toEqual(
      expect.arrayContaining([
        'trt_seed_general_charter',
        'trt_seed_yuwen_charter',
        'trt_seed_math_charter',
        'trt_seed_physics_charter',
      ]),
    );
    const generalSeed = rows.find((r) => r.traitId === 'trt_seed_general_charter');
    expect(generalSeed?.boundBy).toEqual(expect.arrayContaining(['general', id]));
    expect(rows.find((r) => r.traitId === 'trt_seed_math_charter')?.boundBy).toEqual(['math']);
  });

  it('route rejects a missing or unknown kind with 400', async () => {
    expect((await traitsRoute(new Request('http://x/api/admin/traits'))).status).toBe(400);
    expect((await traitsRoute(new Request('http://x/api/admin/traits?kind=nope'))).status).toBe(
      400,
    );
    const ok = await traitsRoute(new Request('http://x/api/admin/traits?kind=charter'));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { traits: unknown[] };
    expect(body.traits.length).toBeGreaterThanOrEqual(4);
  });
});

describe('getTraitJournal — append-only 历史（倒序，无 payload）', () => {
  it('returns the seed create row (actor=migrate) newest-first', async () => {
    const journal = await getTraitJournal(db, 'trt_seed_general_charter');
    expect(journal).not.toBeNull();
    if (!journal) return;
    expect(journal[0]).toMatchObject({ revision: 0, action: 'create', actor: 'migrate' });
    expect(typeof journal[0]?.changeSeq).toBe('number');
    expect(journal[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(journal[0]).not.toHaveProperty('payload');
  });

  it('returns null for an unknown trait; route maps it to 404', async () => {
    expect(await getTraitJournal(db, 'trt_nope')).toBeNull();
    const res = await journalRoute(new Request('http://x/api/admin/traits/trt_nope/journal'), {
      id: 'trt_nope',
    });
    expect(res.status).toBe(404);
  });
});
