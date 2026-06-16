// YUK-372 L3 — family-key.ts 纯逻辑边界单测（no-DB）。
//
// resolveFamilyKeyForQuestion 的 null-guard 分支（缺 primaryKnowledgeId / kind / source 任一
// → null）在任何 DB 调用**之前**早返，故可用一个永不被调用的 fake db 验证。subject 派生 /
// 内存 walk 分支需真 knowledge 树 → 在 candidate-signals.db.test.ts / state.db.test.ts 的 DB 测
// 里覆盖（orphan→'unknown' 等）。

import { describe, expect, it, vi } from 'vitest';
import { batchResolveFamilyKeys, resolveFamilyKeyForQuestion } from './family-key';

// A db whose select() throws — proves the null-guard returns BEFORE touching the DB.
const explodingDb = {
  select: vi.fn(() => {
    throw new Error('db should not be queried on a null-guard path');
  }),
} as never;

describe('resolveFamilyKeyForQuestion — null guards (no DB)', () => {
  it('returns null when primaryKnowledgeId is missing (empty/whitespace/undefined)', async () => {
    for (const pk of [undefined, null, '', '   ']) {
      expect(
        await resolveFamilyKeyForQuestion(explodingDb, {
          primaryKnowledgeId: pk,
          kind: 'short_answer',
          source: 'manual',
        }),
      ).toBeNull();
    }
  });

  it('returns null when kind is missing', async () => {
    expect(
      await resolveFamilyKeyForQuestion(explodingDb, {
        primaryKnowledgeId: 'k1',
        kind: undefined,
        source: 'manual',
      }),
    ).toBeNull();
  });

  it('returns null when source is missing', async () => {
    expect(
      await resolveFamilyKeyForQuestion(explodingDb, {
        primaryKnowledgeId: 'k1',
        kind: 'short_answer',
        source: undefined,
      }),
    ).toBeNull();
  });
});

describe('batchResolveFamilyKeys — empty + null guards (no DB on empty)', () => {
  it('returns an empty map for empty input without querying the DB', async () => {
    const out = await batchResolveFamilyKeys(explodingDb, []);
    expect(out.size).toBe(0);
  });
});
