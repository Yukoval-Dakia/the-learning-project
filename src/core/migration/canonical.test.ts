import { describe, expect, it } from 'vitest';

import { canonicalHash, digestOfIds, stableStringify } from './canonical';

// YUK-1048 — canonical 序列化/哈希原语单测（跨运行稳定性是幂等工件的基础）。

describe('stableStringify', () => {
  it('对象键排序、数组保序', () => {
    expect(stableStringify({ b: 1, a: [2, 1] })).toBe(stableStringify({ a: [2, 1], b: 1 }));
    expect(stableStringify({ a: [2, 1] })).not.toBe(stableStringify({ a: [1, 2] }));
  });

  it('Date 归一为 ISO UTC 字符串（无本地时区漂移）', () => {
    expect(stableStringify({ t: new Date('2026-09-25T00:00:00.000Z') })).toBe(
      stableStringify({ t: '2026-09-25T00:00:00.000Z' }),
    );
  });

  it('undefined 归一为 null（语义相同的两形状哈希一致）', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('嵌套结构与 null/number/string 保真', () => {
    const value = { z: null, y: 1.5, x: 's', w: [{ k: [1, { b: 2, a: 3 }] }] };
    expect(JSON.parse(stableStringify(value))).toEqual({
      w: [{ k: [1, { a: 3, b: 2 }] }],
      x: 's',
      y: 1.5,
      z: null,
    });
  });
});

describe('canonicalHash / digestOfIds', () => {
  it('同语义（键序不同）→ 同哈希', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it('不同事实 → 不同哈希', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });

  it('digestOfIds 是集合语义（输入顺序无关）', () => {
    expect(digestOfIds(['x', 'a', 'm'])).toBe(digestOfIds(['m', 'x', 'a']));
    expect(digestOfIds(['x'])).not.toBe(digestOfIds(['y']));
  });
});
