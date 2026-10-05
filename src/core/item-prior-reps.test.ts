// YUK-1034 — aggregateItemPriorRepDrafts 纯函数单测（无 DB）。
//
// 覆盖：奇/偶数样本 median、单样本恒等、输入顺序无关、confidence 同口径
// median、representative reasoning 选择、reps provenance 后缀（成功/尝试数 +
// 各次 b_logit）、空 drafts throw（= 全部 rep 失败的边界）、界值 ±6。

import { describe, expect, it } from 'vitest';
import { aggregateItemPriorRepDrafts } from './item-prior-reps';
import type { ItemPriorDraftT } from './schema/item_prior';

const draft = (b_logit: number, confidence = 0.4, reasoning = 'x'): ItemPriorDraftT => ({
  b_logit,
  confidence,
  reasoning,
});

describe('aggregateItemPriorRepDrafts', () => {
  it('returns the middle b_logit for an odd number of reps', () => {
    const agg = aggregateItemPriorRepDrafts([
      draft(1.4, 0.5, '高 b 的 reasoning'),
      draft(-0.5, 0.3, '低 b 的 reasoning'),
      draft(0.7, 0.45, '中位 rep 的特征分解：两步推理 + 一个隐蔽坑'),
    ]);
    expect(agg.draft.b_logit).toBeCloseTo(0.7, 10);
    expect(agg.rep_b_logits).toEqual([-0.5, 0.7, 1.4]);
    expect(agg.succeeded).toBe(3);
    expect(agg.attempted).toBe(3);
    // reasoning 取 b 最接近 median 的 rep 原文 + provenance 后缀。
    expect(agg.draft.reasoning).toContain('中位 rep 的特征分解');
    expect(agg.draft.reasoning).toContain('3/3');
    expect(agg.draft.reasoning).toContain('-0.5, 0.7, 1.4');
    expect(agg.draft.reasoning).toContain('median 0.7');
  });

  it('averages the two middle b_logits for an even survivor count (failed rep dropped)', () => {
    // 模拟 reps=3 中 1 个 rep 失败被丢弃：仅剩 2 个 draft。
    const agg = aggregateItemPriorRepDrafts(
      [draft(0.2, 0.4, 'rep A'), draft(0.6, 0.8, 'rep B')],
      3,
    );
    expect(agg.draft.b_logit).toBeCloseTo(0.4, 10);
    // confidence 同口径 median：偶数也取两中位均值。
    expect(agg.draft.confidence).toBeCloseTo(0.6, 10);
    // provenance 记录「2/3 成功」——失败 rep 数可回查。
    expect(agg.draft.reasoning).toContain('2/3');
    expect(agg.succeeded).toBe(2);
    expect(agg.attempted).toBe(3);
  });

  it('is identity over b/confidence for a single rep', () => {
    const agg = aggregateItemPriorRepDrafts([
      draft(-1.25, 0.35, '唯一成功 rep 的长 reasoning：认知步骤数 3，前置链 2'),
    ]);
    expect(agg.draft.b_logit).toBeCloseTo(-1.25, 10);
    expect(agg.draft.confidence).toBeCloseTo(0.35, 10);
    expect(agg.draft.reasoning).toContain('唯一成功 rep');
    expect(agg.draft.reasoning).toContain('1/1');
  });

  it('is order-independent: shuffled inputs give the same median', () => {
    const a = aggregateItemPriorRepDrafts([draft(0.1), draft(0.9), draft(-0.3), draft(0.5)]);
    const b = aggregateItemPriorRepDrafts([draft(0.5), draft(-0.3), draft(0.9), draft(0.1)]);
    // sorted [-0.3, 0.1, 0.5, 0.9] → median (0.1+0.5)/2 = 0.3
    expect(a.draft.b_logit).toBeCloseTo(0.3, 10);
    expect(a.draft.b_logit).toBe(b.draft.b_logit);
    expect(a.rep_b_logits).toEqual(b.rep_b_logits);
  });

  it('picks the reasoning of the rep whose b is closest to the median (deterministic tie-break)', () => {
    // 偶数样本 median=0.5 是 0.4 与 0.6 的均值——两侧等距，确定性取较小侧
    // 首个（升序遍历 + 严格小于比较），不依赖输入顺序。
    const forward = aggregateItemPriorRepDrafts([
      draft(0.6, 0.4, '偏大侧 rep'),
      draft(0.4, 0.4, '偏小侧 rep 的 reasoning'),
    ]);
    const reversed = aggregateItemPriorRepDrafts([
      draft(0.4, 0.4, '偏小侧 rep 的 reasoning'),
      draft(0.6, 0.4, '偏大侧 rep'),
    ]);
    expect(forward.draft.b_logit).toBeCloseTo(0.5, 10);
    expect(forward.draft.reasoning).toContain('偏小侧 rep 的 reasoning');
    expect(reversed.draft.reasoning).toContain('偏小侧 rep 的 reasoning');
  });

  it('handles boundary b values at the schema edge (±6)', () => {
    const agg = aggregateItemPriorRepDrafts([draft(-6), draft(6), draft(0)]);
    expect(agg.draft.b_logit).toBeCloseTo(0, 10);
    expect(agg.rep_b_logits).toEqual([-6, 0, 6]);
  });

  it('handles duplicate b values across reps', () => {
    const agg = aggregateItemPriorRepDrafts([draft(0.5), draft(0.5), draft(0.5)]);
    expect(agg.draft.b_logit).toBeCloseTo(0.5, 10);
    expect(agg.rep_b_logits).toEqual([0.5, 0.5, 0.5]);
  });

  it('throws on empty drafts (all reps failed — caller applies skip semantics)', () => {
    expect(() => aggregateItemPriorRepDrafts([])).toThrow(/no successful rep drafts/);
  });

  it('never reports attempted below succeeded', () => {
    const agg = aggregateItemPriorRepDrafts([draft(0.1), draft(0.2)], 1);
    expect(agg.attempted).toBe(2);
    expect(agg.draft.reasoning).toContain('2/2');
  });
});
