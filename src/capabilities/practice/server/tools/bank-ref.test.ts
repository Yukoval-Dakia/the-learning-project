// ADR-0072 D2 — bank ref 纯函数单元（语法/解析/前缀/形状派生）。
// 解析语义的 DB 路径（unresolvable/digest_mismatch/withdrawn）在 db partition
// （search-bank.db.test.ts / read-bank.db.test.ts）覆盖。

import { describe, expect, it } from 'vitest';
import type { BankRefRevisionRow } from './bank-ref';
import {
  BANK_REF_DIGEST_PREFIX_LEN,
  BANK_REF_VERSION,
  bankRefDigestPrefix,
  bankRefObjectKind,
  encodeBankRef,
  parseBankRef,
} from './bank-ref';

const REVISION_ID = 'ck8xyz123abc456def';
const DIGEST_HEX = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

function revisionWithParts(parts: unknown[]): BankRefRevisionRow {
  return { structure: { parts } } as unknown as BankRefRevisionRow;
}

describe('bankRefDigestPrefix', () => {
  it('takes the first 12 hex chars after the sha256: prefix', () => {
    expect(bankRefDigestPrefix(`sha256:${DIGEST_HEX}`)).toBe('0f1e2d3c4b5a');
    expect(BANK_REF_DIGEST_PREFIX_LEN).toBe(12);
  });

  it('accepts a bare hex digest too', () => {
    expect(bankRefDigestPrefix(DIGEST_HEX)).toBe('0f1e2d3c4b5a');
  });
});

describe('encodeBankRef / parseBankRef', () => {
  it('round-trips', () => {
    const ref = encodeBankRef(REVISION_ID, `sha256:${DIGEST_HEX}`);
    expect(ref).toBe(`${BANK_REF_VERSION}:${REVISION_ID}:0f1e2d3c4b5a`);
    expect(parseBankRef(ref)).toEqual({ revisionId: REVISION_ID, digestPrefix: '0f1e2d3c4b5a' });
  });

  it('rejects a wrong grammar version', () => {
    expect(parseBankRef(`qrev2:${REVISION_ID}:0f1e2d3c4b5a`)).toBeNull();
  });

  it('rejects malformed segments', () => {
    expect(parseBankRef('qrev1:short:0f1e2d3c4b5a')).toBeNull(); // revision id too short
    expect(parseBankRef(`qrev1:${REVISION_ID}:0F1E2D3C4B5A`)).toBeNull(); // 非 hex 小写
    expect(parseBankRef(`qrev1:${REVISION_ID}:0f1e2d3c4b5`)).toBeNull(); // 11 位
    expect(parseBankRef(`qrev1:${REVISION_ID}:0f1e2d3c4b5a:extra`)).toBeNull(); // 多段
    expect(parseBankRef('')).toBeNull();
  });

  it('rejects a ref with punctuation injected into the revision id', () => {
    expect(parseBankRef(`qrev1:${REVISION_ID};DROP:0f1e2d3c4b5a`)).toBeNull();
  });
});

describe('bankRefObjectKind', () => {
  it('derives question for a 1-part group', () => {
    expect(bankRefObjectKind(revisionWithParts([{ part_id: 'p1' }]))).toBe('question');
  });

  it('derives group for a multi-part composite (even with no shared materials)', () => {
    expect(bankRefObjectKind(revisionWithParts([{ part_id: 'p1' }, { part_id: 'p2' }]))).toBe(
      'group',
    );
  });

  it('derives question for a single part that carries a shared figure material', () => {
    // D2：group = 父题 + part 的既有分组；单题带共享材料仍是单题。
    expect(
      bankRefObjectKind(revisionWithParts([{ part_id: 'p1', material_ids: ['mat_fig'] }])),
    ).toBe('question');
  });
});
