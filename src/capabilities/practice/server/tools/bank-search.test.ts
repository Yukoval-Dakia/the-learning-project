// ADR-0072 D2/D6 — search_bank 纯函数单元：RRF 融合与 cursor 语义。
// SQL 通道（FTS/向量/硬过滤）与卡片组装在 db partition（search-bank.db.test.ts）
// 覆盖；查询嵌入一律确定性 fake（本文件不触嵌入）。

import { describe, expect, it } from 'vitest';

import {
  BANK_SEARCH_RRF_K,
  bankSearchFingerprint,
  decodeBankSearchCursor,
  encodeBankSearchCursor,
  rrfFuse,
} from './bank-search';

describe('rrfFuse', () => {
  it('sums 1/(k+rank+1) across channels and orders desc', () => {
    const fused = rrfFuse([
      {
        name: 'fts',
        hits: [
          { id: 'a', rank: 0 },
          { id: 'b', rank: 1 },
        ],
      },
      {
        name: 'vector',
        hits: [
          { id: 'b', rank: 0 },
          { id: 'c', rank: 1 },
        ],
      },
    ]);
    // b: 1/(k+2) + 1/(k+1)；a: 1/(k+1)；c: 1/(k+2)
    const b = 1 / (BANK_SEARCH_RRF_K + 1 + 1) + 1 / (BANK_SEARCH_RRF_K + 0 + 1);
    const a = 1 / (BANK_SEARCH_RRF_K + 0 + 1);
    const c = 1 / (BANK_SEARCH_RRF_K + 1 + 1);
    expect(fused.map((f) => f.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0].score).toBeCloseTo(b, 12);
    expect(fused.find((f) => f.id === 'a')?.score).toBeCloseTo(a, 12);
    expect(fused.find((f) => f.id === 'c')?.score).toBeCloseTo(c, 12);
    expect(fused.find((f) => f.id === 'b')?.channels).toEqual(['fts', 'vector']);
  });

  it('breaks score ties deterministically by id', () => {
    const fused = rrfFuse([
      {
        name: 'fts',
        hits: [
          { id: 'zz', rank: 0 },
          { id: 'aa', rank: 1 },
        ],
      },
    ]);
    expect(fused.map((f) => f.id)).toEqual(['zz', 'aa']);
    const tied = rrfFuse([
      { name: 'fts', hits: [{ id: 'aa', rank: 3 }] },
      { name: 'vector', hits: [{ id: 'zz', rank: 3 }] },
    ]);
    expect(tied.map((f) => f.id)).toEqual(['aa', 'zz']);
  });

  it('sums every hit contribution but lists a repeated channel name once (engine never sends duplicate names)', () => {
    const fused = rrfFuse([
      { name: 'fts', hits: [{ id: 'a', rank: 0 }] },
      { name: 'fts', hits: [{ id: 'a', rank: 5 }] },
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0].channels).toEqual(['fts']);
    expect(fused[0].score).toBeCloseTo(
      1 / (BANK_SEARCH_RRF_K + 1) + 1 / (BANK_SEARCH_RRF_K + 5 + 1),
      12,
    );
  });

  it('returns an empty pool for empty channels', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([{ name: 'fts', hits: [] }])).toEqual([]);
  });
});

describe('bank-search cursor', () => {
  const scope = { draft_state: 'all', admission_state: 'any' } as const;

  it('round-trips query/scope/limit/offset', () => {
    const cursor = encodeBankSearchCursor({
      v: 1,
      q: '需要检查定义域的方程题',
      scope,
      limit: 20,
      offset: 20,
    });
    const decoded = decodeBankSearchCursor(cursor);
    expect(decoded).toMatchObject({
      v: 1,
      q: '需要检查定义域的方程题',
      limit: 20,
      offset: 20,
      scope: { draft_state: 'all', admission_state: 'any' },
    });
    expect(decoded.f).toBe(bankSearchFingerprint('需要检查定义域的方程题', scope, 20));
  });

  it('rejects a tampered cursor (fingerprint mismatch) — no silent condition swap', () => {
    const cursor = encodeBankSearchCursor({ v: 1, q: '电路题', scope, limit: 20, offset: 0 });
    const forged = Buffer.from(
      JSON.stringify({ ...decodeBankSearchCursor(cursor), q: '改成别的条件' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeBankSearchCursor(forged)).toThrow(/fingerprint mismatch/);
  });

  it('rejects invalid payloads', () => {
    expect(() => decodeBankSearchCursor('not-base64url-JSON!!')).toThrow(/not a valid/);
    const wrongVersion = Buffer.from(
      JSON.stringify({ v: 2, q: 'x', scope, limit: 20, offset: 0, f: '0'.repeat(16) }),
    ).toString('base64url');
    expect(() => decodeBankSearchCursor(wrongVersion)).toThrow(/not a valid/);
    const negativeOffset = Buffer.from(
      JSON.stringify({ v: 1, q: 'x', scope, limit: 20, offset: -1, f: '0'.repeat(16) }),
    ).toString('base64url');
    expect(() => decodeBankSearchCursor(negativeOffset)).toThrow(/not a valid/);
  });
});
