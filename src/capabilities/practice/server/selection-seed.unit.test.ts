// YUK-558 C2 — 惰性自记日志 seed thunk 单测：未消费零日志 / 首消费恰一次 / 数值流逐位 = 裸
// mulberry32(seed)。日志推迟到首次真实抽签，让已物化流 GET / no-op nightly / 非 rerank PATCH
// 零 decoy「seeded」行。

import { mulberry32 } from '@/server/calibration/rng';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSeededSelectionRng, hashSelectionSeed } from './selection-seed';

describe('buildSeededSelectionRng lazy self-logging thunk (YUK-558 C2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unconsumed rng → zero log (no decoy on materialized GET / no-op nightly / non-rerank PATCH)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // 构造但从不调用（caller 无条件构造并 DI 注入，但许多路径根本不抽签）。
    buildSeededSelectionRng('2026-07-03', 'compose', '2026-07-03');
    expect(spy).not.toHaveBeenCalled();
  });

  it('first consumption logs exactly once; subsequent draws do not re-log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rng = buildSeededSelectionRng('2026-07-03', 'compose', '2026-07-03');
    rng();
    rng();
    rng();
    const seedLogs = spy.mock.calls.filter((c) => c[0] === '[selection] seeded');
    expect(seedLogs).toHaveLength(1); // 恰一次（首抽），不随后续 draw 重打。
    expect(seedLogs[0][1]).toMatchObject({
      eventKind: 'compose',
      triggerId: '2026-07-03',
      localDate: '2026-07-03',
      seed: hashSelectionSeed('2026-07-03', 'compose', '2026-07-03'),
    });
  });

  it('numeric stream is bit-for-bit identical to bare mulberry32(seed)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const seed = hashSelectionSeed('2026-07-03', 'rerank', 'item-x');
    const seeded = buildSeededSelectionRng('2026-07-03', 'rerank', 'item-x');
    const bare = mulberry32(seed);
    const fromSeeded = Array.from({ length: 20 }, () => seeded());
    const fromBare = Array.from({ length: 20 }, () => bare());
    expect(fromSeeded).toEqual(fromBare);
  });
});
