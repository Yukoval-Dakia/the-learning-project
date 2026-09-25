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

  it('P2-A 回归：own __proto__ 键不丢、不污染原型、不哈希碰撞', () => {
    // JSON.parse 会把 "__proto__" 建为【普通 own 属性】；普通对象累加器上
    // out['__proto__'] = v 却会写原型 —— 既丢键文可能碰撞。null 原型累加器
    // 下它是普通自有键。
    const parsed = JSON.parse('{"__proto__":{"x":1},"a":2}') as Record<string, unknown>;
    const out = stableStringify(parsed);
    // 键排序 '_' < 'a' ⇒ __proto__ 在前；关键是它作为普通键保留。
    expect(out).toBe('{"__proto__":{"x":1},"a":2}');
    // 与键名不同的对象不碰撞。
    expect(canonicalHash(parsed)).not.toBe(canonicalHash({ a: 2 }));
    expect(canonicalHash(parsed)).not.toBe(canonicalHash(JSON.parse('{"a":2}')));
    // 不污染（Object.prototype 仍干净）。
    expect(({} as Record<string, unknown>).x).toBeUndefined();
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
