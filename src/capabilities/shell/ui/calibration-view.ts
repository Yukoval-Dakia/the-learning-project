// YUK-523 — 校准诊断视图的纯展示逻辑（tier 派生 / 排序 / θ̂ SE 分布定位 / lane 堆叠）。
//
// 喂入既有读模型 CalibrationMaturityResponse（getCalibrationMaturity，calibration-maturity-api.ts）——
// 读模型/逻辑不动，本文件只把 row 映成展示用形态。零写路径、零 DB → unit 车道。
//
// ⑥红线（gate doc §1.5.2 ⑥ + ADR-0035）：tier 只表「可信 / 不可信 + 相对次序」，绝不当精确掌握分；
// θ̂ SE 是置信量（标准误，越小越可信），不是掌握度 %。证据不足 → 不补一个看起来精确的分数。
//
// 逐字 PORT 自设计 docs/design/loom-refresh/project/screen-calibration.jsx 的
// calTier / 排序比较器 / seX / lane 分桶；real-model 适配：theta_se=null（无 mastery_state 行 /
// 冷启）回落冷启先验 SE。

import type { CalibrationMaturityRow } from '@/capabilities/onboarding/ui/recompute/calibration-maturity-api';

export type CalTier = 'firm' | 'warming' | 'blind';

// 冷启盲区先验 SE：evidence=0 / 无 mastery_state 行（theta_se=null）→ θ̂ 停在冷启先验 ≈ 1.00。
export const COLD_START_SE = 1.0;
// θ̂ SE 分布带右端（可信端）参照：se 1.0(冷启,左) → SE_LO(可信,右)。
export const SE_LO = 0.18;

export interface CalRow extends CalibrationMaturityRow {
  tier: CalTier;
  /** 展示用 SE：无 mastery_state 行（theta_se=null）回落冷启先验。仅相对排序，绝不当精确分。 */
  display_se: number;
}

// tier 派生（设计 calTier）：evidence=0 → blind（盲区）；cold_start → warming（渐稳）；否则 firm（可信）。
export function calTier(row: CalibrationMaturityRow): CalTier {
  if (row.evidence_count === 0) return 'blind';
  return row.cold_start ? 'warming' : 'firm';
}

export function toCalRows(rows: CalibrationMaturityRow[]): CalRow[] {
  return rows.map((r) => ({
    ...r,
    tier: calTier(r),
    display_se: r.theta_se ?? COLD_START_SE,
  }));
}

export interface CalCounts {
  firm: number;
  warming: number;
  blind: number;
}

export function calCounts(rows: CalRow[]): CalCounts {
  return {
    firm: rows.filter((r) => r.tier === 'firm').length,
    warming: rows.filter((r) => r.tier === 'warming').length,
    blind: rows.filter((r) => r.tier === 'blind').length,
  };
}

export type CalSortKey = 'name' | 'evidence' | 'se' | 'tier';
export type CalSortDir = 1 | -1;
export interface CalSort {
  key: CalSortKey;
  dir: CalSortDir;
}

const TIER_RANK: Record<CalTier, number> = { firm: 0, warming: 1, blind: 2 };

// 比较两行（升序方向，dir 由调用方乘）。避免嵌套三元：用 if/else 链。
function calCompare(x: CalRow, y: CalRow, key: CalSortKey): number {
  if (key === 'name') return x.name.localeCompare(y.name, 'zh');
  if (key === 'evidence') return x.evidence_count - y.evidence_count;
  if (key === 'se') return x.display_se - y.display_se;
  // tier：先按成熟度 rank，再按 SE 兜底（同 tier 内可信者靠前）。
  return TIER_RANK[x.tier] - TIER_RANK[y.tier] || x.display_se - y.display_se;
}

export function calSorted(rows: CalRow[], sort: CalSort): CalRow[] {
  const out = [...rows];
  out.sort((x, y) => calCompare(x, y, sort.key) * sort.dir);
  return out;
}

// 点表头排序：同列翻向；异列默认升序（evidence 默认降序——证据多的在上）。
export function nextSort(prev: CalSort, key: CalSortKey): CalSort {
  // 同列翻向：用显式三元而非 `-prev.dir as CalSortDir`——后者 negate 得 number、靠 as 掩盖
  // 类型洞（OCR）。三元保持窄类型 1|-1，无断言。
  if (prev.key === key) return { key, dir: prev.dir === 1 ? -1 : 1 };
  return { key, dir: key === 'evidence' ? -1 : 1 };
}

// 表头排序指示符（设计 caret）。非活动列空串；活动列按方向出 ↑/↓。避免组件里写嵌套三元。
export function sortCaret(sort: CalSort, key: CalSortKey): string {
  if (sort.key !== key) return '';
  return sort.dir === 1 ? ' ↑' : ' ↓';
}

// 可排序表头的 ARIA `aria-sort` 值（WAI-ARIA grid）。屏幕阅读器据此稳定读出当前排序列+方向；
// 视觉 caret 只是补充。非活动列 'none'，活动列按方向 ascending/descending（CodeRabbit a11y）。
export type AriaSort = 'none' | 'ascending' | 'descending';
export function ariaSortFor(sort: CalSort, key: CalSortKey): AriaSort {
  if (sort.key !== key) return 'none';
  return sort.dir === 1 ? 'ascending' : 'descending';
}

// θ̂ SE → 分布带 x%（越右越可信）。clamp [2,98] 防越界。
export function seToX(se: number): number {
  const x = ((COLD_START_SE - se) / (COLD_START_SE - SE_LO)) * 100;
  return Math.max(2, Math.min(98, x));
}

// θ̂ SE → ledger 内填充条宽 %（se=1.00 冷启端 → 0%，se=SE_LO 可信端 → 100%）。clamp [0,100]。
export function seFillPct(se: number): number {
  const pct = (1 - (se - SE_LO) / (COLD_START_SE - SE_LO)) * 100;
  return Math.max(0, Math.min(100, pct));
}

export interface CalDot extends CalRow {
  x: number;
  lane: number;
}

// strip-track 高 120px，dot 纵向定位 bottom=14+lane*19px → lane≥6 即溢出轨道顶。冷启期
// 大量 KC 同 SE=1.00 桶会让 lane 线性增长撑爆（OCR）。cap 到 MAX_DOT_LANES：超出的点压在
// 最高一层（密叠但不溢出，冷启「一堆点挤左端」本就该密），与 CSS 14+lane*19 上限互为契约。
export const MAX_DOT_LANES = 5;

// 同 SE（2 位小数）的点纵向堆叠（lane 0,1,2…），避免重叠（n=1 冷启期多点挤在左端）。
export function calDots(rows: CalRow[]): CalDot[] {
  const buckets: Record<string, number> = {};
  return rows.map((r) => {
    const key = r.display_se.toFixed(2);
    const rawLane = buckets[key] ?? 0;
    buckets[key] = rawLane + 1;
    const lane = Math.min(rawLane, MAX_DOT_LANES - 1);
    return { ...r, x: seToX(r.display_se), lane };
  });
}
