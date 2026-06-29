// A5 S1 (YUK-354) — mastery band 纯展示派生（⑥治理首个载体）。
// p(L) 点估计 + 真实 σ 区间（mastery_lo / mastery_hi）→ 4 档离散 band + 来源二态 +
// 低置信旗。纯函数、零写回（三轴正交：band 只展示 p(L) 轴，不耦合 R/difficulty）。
//
// ⚠️ 避坑：source 的 'hard'/'soft' 是 A5 的「校准 vs 先验」源二态
//   （evidence_count>0 → hard=有校准证据 / ===0 → soft=先验），**绝非**
//   src/server/mastery/state.ts 满屏的 item_calibration.track（题难度轨道，同名）。
//
// ⚠️ 设计 mock 偏离：设计源 screen-knowledge-a5.jsx 的 masteryBand 用 evidence 阈值
//   **估算** lo/hi（band±spread）。这里用真实 mastery_lo / mastery_hi 各自过
//   masteryBandIdx 得真区间档，不照搬 mock 估算。
//
// 参考 mastery-tone.ts 的 0.67 / 0.45（3-tone），但扩到 4 档（阈值具名常量）。

// 4 档 p(L) 阈值（0-1 概率域）。每个值是对应档的下界。
export const MASTERY_BAND_THRESHOLDS = {
  /** 萌芽 < 0.4 ≤ 成长 */
  growing: 0.4,
  /** 成长 < 0.6 ≤ 稳固 */
  solid: 0.6,
  /** 稳固 < 0.8 ≤ 精熟 */
  mastered: 0.8,
} as const;

// 4 档名（与设计源 A5_BANDS 同名同序）。
export const A5_BANDS = ['萌芽', '成长', '稳固', '精熟'] as const;

// 冷启/不可得态的显式档名——一等「未知」态，绝不当 0（萌芽）。
export const UNKNOWN_BAND_LABEL = '未知';

export type MasteryBandIdx = 0 | 1 | 2 | 3;
export type MasterySource = 'hard' | 'soft';

/** 单 p(L) 点（0-1）映射到 4 档 band idx。 */
export function masteryBandIdx(p: number): MasteryBandIdx {
  if (p < MASTERY_BAND_THRESHOLDS.growing) return 0;
  if (p < MASTERY_BAND_THRESHOLDS.solid) return 1;
  if (p < MASTERY_BAND_THRESHOLDS.mastered) return 2;
  return 3;
}

// BandChip 所需的最小读形状——node-page 焦点 wire 与树/图行 wire 都按这些字段名
// 暴露（结构化子类型即满足，无需映射）。mastery==null = 冷启（never-attempted，
// 缺席 projection map）。
export interface MasteryBandInput {
  mastery: number | null;
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
}

// 判别式联合：冷启未知态 vs 有据态。BandChip 按 `unknown` narrow，不裸渲 0。
export type MasteryBandView =
  | {
      unknown: true;
      source: MasterySource;
      lowConf: boolean;
    }
  | {
      unknown: false;
      band: MasteryBandIdx;
      loBand: MasteryBandIdx;
      hiBand: MasteryBandIdx;
      source: MasterySource;
      lowConf: boolean;
    };

/**
 * 冷启态：KC 缺席 projection map / mastery 不可得。一等「未知档」+ soft（先验）+
 * lowConf（先验从不高置信）。
 */
export function masteryBandUnknown(): MasteryBandView {
  return { unknown: true, source: 'soft', lowConf: true };
}

/**
 * MasteryProjection（或同形 wire 行）→ band 展示视图。纯派生，绝不写回任何轴。
 * - band = masteryBandIdx(mastery)
 * - loBand / hiBand = 真实 mastery_lo / mastery_hi 各自过 masteryBandIdx（真区间档，
 *   非 mock 的 evidence 估算）；wire 未带区间时退回点 band（不伪造精度）。
 * - source = evidence_count>0 ? 'hard'(有校准证据) : 'soft'(先验)。绝不碰
 *   item_calibration.track。
 * - lowConf = 真实 low_confidence 透传。
 * - mastery==null（冷启）→ masteryBandUnknown()。
 */
export function masteryBandView(input: MasteryBandInput): MasteryBandView {
  if (input.mastery == null) return masteryBandUnknown();
  const band = masteryBandIdx(input.mastery);
  const loBand = input.mastery_lo == null ? band : masteryBandIdx(input.mastery_lo);
  const hiBand = input.mastery_hi == null ? band : masteryBandIdx(input.mastery_hi);
  const source: MasterySource = input.evidence_count > 0 ? 'hard' : 'soft';
  return { unknown: false, band, loBand, hiBand, source, lowConf: input.low_confidence };
}
