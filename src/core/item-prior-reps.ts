// YUK-1034 — feature→b 同题 N 次重复采样的 median 聚合（纯函数，零 IO）。
//
// 实测动机（YUK-376 eval，docs/planning/2026-09-23-llasa-prior-eval.md 封存）：
// feature→b 单次采样 within-question SD ≈ 0.30 mean / 0.28 median（30 题 × 3
// reps，xiaomi/mimo-v2.5-pro）。同法 N 次采样取 b_logit median 是已验证的最便宜
// 降噪杠杆——不改估计目标、不引入新链路，实测分布下 median-of-3 有效 SD 期望
// ~0.17，成本随 reps 线性（≈+$0.0004/题·rep）。
//
// 聚合口径（全部确定性，可复算）：
//   - b_logit：各成功 rep 的 median（偶数个 → 两中位均值，标准定义；奇偶对称
//     不偏向任何一侧 rep）；
//   - confidence：同取 median——重复采样压的是估计方差，不是模型自知把握，
//     聚合置信度保持中位水平，不凭空拔高；
//   - reasoning：取 b_logit 最接近 median 的那次 rep 的原文（该 rep 的特征
//     分析最能代表聚合结论），追加聚合 provenance 后缀（成功/尝试数 + 各次
//     b_logit）。reasoning 不落 item_calibration 列（applier 只写
//     b/confidence）；各 rep 原始输出由各自 ai_task_run 行持久留痕，此处
//     provenance 保证聚合值在任何 draft 消费点可读、可审计。
//   - 失败 rep 由调用方丢弃后才进本函数；drafts 为空 → throw（调用方按既有
//     单题失败语义 skip/重试，与单次失败同路径）。

import type { ItemPriorDraftT } from './schema/item_prior';

export interface ItemPriorRepAggregation {
  /** 聚合后的 draft：b_logit/confidence 取 median，reasoning 含 provenance 后缀。 */
  draft: ItemPriorDraftT;
  /** 各成功 rep 的 b_logit（升序）。 */
  rep_b_logits: number[];
  /** 聚合掉的成功 rep 数（= rep_b_logits.length）。 */
  succeeded: number;
  /** 调用方声明的总尝试 rep 数（含失败丢弃）。 */
  attempted: number;
}

/** 已升序数组的中位数；偶数个取两中位均值。空数组 → NaN（调用方保证非空）。 */
function medianOfSorted(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const fmtB = (x: number): string => String(Number(x.toFixed(3)));

/**
 * 把同一道题的 N 次 feature→b 采样折成一个 ItemPriorDraftT。
 * throws：drafts 为空（全部 rep 失败）——调用方按既有失败语义当本轮跳过。
 */
export function aggregateItemPriorRepDrafts(
  drafts: readonly ItemPriorDraftT[],
  attempted: number = drafts.length,
): ItemPriorRepAggregation {
  if (drafts.length === 0) {
    throw new Error('aggregateItemPriorRepDrafts: no successful rep drafts to aggregate');
  }
  const byB = [...drafts].sort((a, b) => a.b_logit - b.b_logit);
  const repBLogits = byB.map((d) => d.b_logit);
  const bMedian = medianOfSorted(repBLogits);
  const confMedian = medianOfSorted(drafts.map((d) => d.confidence).sort((a, b) => a - b));
  // 代表 rep = b_logit 离 median 最近者。升序遍历 + 严格小于 ⇒ 平局确定性取
  // 较小侧首个，不依赖输入顺序。
  const representative = byB.reduce((best, d) =>
    Math.abs(d.b_logit - bMedian) < Math.abs(best.b_logit - bMedian) ? d : best,
  );
  const effectiveAttempted = Math.max(attempted, drafts.length);
  const provenance = `[reps median 聚合：${drafts.length}/${effectiveAttempted} 成功；b_logit 各次 ${repBLogits.map(fmtB).join(', ')} → median ${fmtB(bMedian)}]`;
  return {
    draft: {
      b_logit: bMedian,
      confidence: confMedian,
      reasoning: `${representative.reasoning} ${provenance}`,
    },
    rep_b_logits: repBLogits,
    succeeded: drafts.length,
    attempted: effectiveAttempted,
  };
}
