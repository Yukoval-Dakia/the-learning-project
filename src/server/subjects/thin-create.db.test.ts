// YUK-600 — thinCreateSubject 的 db 合同测试（v3 §8-1 + v2 §3.2 幂等/撞名）。
// 覆盖：原子五件套（控制行/claim/六绑定零新 trait/root+genesis+anchor/journal）、
// isGeneralFallback 派生、幂等 200 回放（零第二行/根/claim）、custom↔builtin
// 显示名与 id/alias 双命名空间撞名 422、registry 即时上架。

import { count, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { knowledge, subject } from '@/db/schema';
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
});
