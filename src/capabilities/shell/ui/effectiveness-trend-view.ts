// YUK-354 (A7) — effectiveness 趋势面的**纯视图逻辑**（无 DB / 无 React / 无 schema）。
//
// 抽出来让安全关键的判定（合成根识别 / ⑥低置信降级映射 / 科目分桶）可在 no-DB unit
// 车道单测。EffectivenessTrendPanel.tsx 从这里 import 同一套函数——单一真相，UI 与测试
// 不漂移。读模型契约见 effectiveness-trend-api.ts（与 server 锁步）。
//
// ⑥硬约束（gate doc §1.5.2 ⑥ + ADR-0035 §决定1）：趋势绝不裸 delta；方向用定性档，
// 低置信显著降级；`insufficient`/`low` 是一等公民态而非错误态。本模块只做「方向 + 置信 →
// 视觉档」的映射，不产出任何 delta 数字。

import type {
  EffectivenessTrendPoint,
  EffectivenessTrendSeries,
  SubjectTrendRollup,
  TrendConfidence,
  TrendDirection,
} from './effectiveness-trend-api';

// ── 合成根毛刺 ① — seed-root 自指识别 ──────────────────────────────────────────
// 冷启期题挂在 seed root（`seed:<subjectId>:root`，domain=subjectId）→ mastery_progress
// 事件 subject_id = 该 root → root 既是一条 series 行、又是该科目桶。面板须把这条行识别为
// 「科目整体」，不当作科目下的某个 KC 渲染（handoff「多科目+规模」毛刺 ①）。
const SEED_ROOT_RE = /^seed:.+:root$/;

export function isSeedRoot(knowledgeId: string): boolean {
  return SEED_ROOT_RE.test(knowledgeId);
}

// ── 合成根毛刺 ③ — 未归类桶 ────────────────────────────────────────────────────
// effective_domain === null 的孤儿 KC → 与各科同级显式「未归类」桶（不藏、不并科）。
export const UNCATEGORIZED_LABEL = '未归类';

// ── 方向视觉档（与 data-efficacy.jsx EFF_DIR 同语义；置信值用读模型契约 low/medium/high）──
export interface DirectionMeta {
  label: string;
  glyph: string;
  /** CSS tone 后缀（tone-good / tone-hold / tone-down / tone-insf）。 */
  tone: 'good' | 'hold' | 'down' | 'insf';
}

export const DIRECTION_META: Record<TrendDirection, DirectionMeta> = {
  rising: { label: '在涨', glyph: '↑', tone: 'good' },
  holding: { label: '持平', glyph: '→', tone: 'hold' },
  falling: { label: '在退', glyph: '↓', tone: 'down' },
  insufficient: { label: '数据不足', glyph: '·', tone: 'insf' },
};

export function directionMeta(direction: TrendDirection): DirectionMeta {
  return DIRECTION_META[direction];
}

// ── ⑥ 置信视觉档 ──────────────────────────────────────────────────────────────
// 读模型置信值 = low/medium/high；direction=insufficient 时压成专门的 insf 档（证据太少，
// 连方向都不该断言）。is-firm/is-mid/is-low/is-insf 对应 efficacy.css 的置信 chip 样式。
export type ConfidenceClass = 'is-firm' | 'is-mid' | 'is-low' | 'is-insf';

export function confidenceClass(
  direction: TrendDirection,
  confidence: TrendConfidence,
): ConfidenceClass {
  if (direction === 'insufficient') return 'is-insf';
  if (confidence === 'high') return 'is-firm';
  if (confidence === 'medium') return 'is-mid';
  return 'is-low';
}

export interface ConfidenceLabel {
  full: string;
  mini: string;
}

const CONFIDENCE_LABEL: Record<ConfidenceClass, ConfidenceLabel> = {
  'is-firm': { full: '够硬 · 方向可信', mini: '够硬' },
  'is-mid': { full: '方向可信 · 幅度别当真', mini: '够看' },
  'is-low': { full: '低置信 · 别当真', mini: '还嫩' },
  'is-insf': { full: '数据不足 · 别断方向', mini: '不足' },
};

export function confidenceLabel(cls: ConfidenceClass): ConfidenceLabel {
  return CONFIDENCE_LABEL[cls];
}

// ⑥ 低置信显著降级：confidence=low 或 direction=insufficient 的行要一眼看出「别当真」
// （去饱和 + 虚线 + 宽不确定带）。这是「嫩数据」的默认态，不是错误态。
export function isTender(direction: TrendDirection, confidence: TrendConfidence): boolean {
  return confidence === 'low' || direction === 'insufficient';
}

// ── 科目分桶（合成根毛刺 ① + 规模 rollup-first）────────────────────────────────
export interface SubjectPartition {
  /** seed-root 自指行（科目整体；子 KC 未抽出时唯一的轨迹）。无 → null。 */
  whole: EffectivenessTrendSeries | null;
  /** 真正的子 KC 行（已剔除 seed-root）。 */
  kcs: EffectivenessTrendSeries[];
}

/** 取某 effective_domain 下的 series 行（null domain = 未归类桶）。 */
export function seriesForDomain(
  series: EffectivenessTrendSeries[],
  domain: string | null,
): EffectivenessTrendSeries[] {
  return series.filter((s) => s.effective_domain === domain);
}

/**
 * 把一个科目的 series 行分成「科目整体（seed-root）」+「真子 KC」两堆。
 * 毛刺 ①：seed-root 行识别为科目整体，不混进 KC 列。
 */
export function partitionSubjectSeries(rows: EffectivenessTrendSeries[]): SubjectPartition {
  let whole: EffectivenessTrendSeries | null = null;
  const kcs: EffectivenessTrendSeries[] = [];
  for (const row of rows) {
    if (isSeedRoot(row.knowledge_id)) {
      // 多条 seed-root 不该出现；保险起见取第一条为整体行，其余并入（不丢数据）。
      if (whole === null) whole = row;
      else kcs.push(row);
    } else {
      kcs.push(row);
    }
  }
  return { whole, kcs };
}

// ── 规模：「本期动了的」+ 折叠的「已沉淀」──────────────────────────────────────
// 首屏只高亮涨/退的少数 KC，holding/insufficient 多数默认折叠成计数（handoff 规模节）。
export function selectMovedKcs(kcs: EffectivenessTrendSeries[]): EffectivenessTrendSeries[] {
  return kcs.filter((k) => k.trend.direction === 'rising' || k.trend.direction === 'falling');
}

export interface SettledCounts {
  holding: number;
  insufficient: number;
}

export function countSettled(kcs: EffectivenessTrendSeries[]): SettledCounts {
  let holding = 0;
  let insufficient = 0;
  for (const k of kcs) {
    if (k.trend.direction === 'holding') holding += 1;
    else if (k.trend.direction === 'insufficient') insufficient += 1;
  }
  return { holding, insufficient };
}

// ── 整面方向分布（概览条 + ⑥「多数低置信」诚实信号）──────────────────────────
export interface DirectionCounts {
  rising: number;
  holding: number;
  falling: number;
  insufficient: number;
}

export interface OverviewSummary {
  counts: DirectionCounts;
  total: number;
  /** 有可信 mastery 趋势的 KC 数（has_mastery_signal && confidence!=='low'）。 */
  firm: number;
  /** 其余还嫩的 KC 数。n=1 慢热下这通常是多数——⑥ 默认态。 */
  tender: number;
}

export function summarizeOverview(series: EffectivenessTrendSeries[]): OverviewSummary {
  const counts: DirectionCounts = { rising: 0, holding: 0, falling: 0, insufficient: 0 };
  let firm = 0;
  for (const s of series) {
    counts[s.trend.direction] += 1;
    if (s.trend.has_mastery_signal && s.trend.confidence !== 'low') firm += 1;
  }
  return { counts, total: series.length, firm, tender: series.length - firm };
}

// ── 轨迹几何（纯 SVG path 计算；端口自 eff-viz.jsx effTrajGeom + effBandHalf）──────
// 用 p(L)（0..1）作相对位置纵轴。⑥：低置信 → 不确定带更宽，盖过线，绝不画成笃定细箭头。

/** 取轨迹的 p(L) 数值序列（剔除缺失点）。全空 → 空数组（退化态，不画线）。 */
export function pointsToValues(points: EffectivenessTrendPoint[]): number[] {
  const out: number[] = [];
  for (const p of points) {
    if (p.p_learned !== null && Number.isFinite(p.p_learned)) out.push(p.p_learned);
  }
  return out;
}

export type BandTier = 'firm' | 'mid' | 'low';

// 从 confidenceClass 派生 bandTier（单一真相，防漂移）：两者本是同一「置信 → 视觉档」
// 映射，分开手写会在 API 加新置信档时各自漏更新 → 视觉不一致。is-insf/is-low 都落 low 带。
const CONF_CLASS_TO_TIER: Record<ConfidenceClass, BandTier> = {
  'is-firm': 'firm',
  'is-mid': 'mid',
  'is-low': 'low',
  'is-insf': 'low',
};

export function bandTier(direction: TrendDirection, confidence: TrendConfidence): BandTier {
  return CONF_CLASS_TO_TIER[confidenceClass(direction, confidence)];
}

// ⑥ 不确定带半宽常量（p 单位）。低置信 → 更宽；带宽绝不画成笃定细线。命名而非散落 magic
// number，便于审计这条安全关键视觉规则（查表替链式三元，守项目「禁嵌套三元」）。
const BAND_HALF_BY_TIER: Record<BandTier, number> = { firm: 0.045, mid: 0.085, low: 0.155 };
const TWO_POINT_BAND_HALF = 0.22; // ≤2 点：连方向都不该断，带宽极大盖过线
const MAX_BAND_HALF = 0.26; // 不确定带半宽上限
const EARLY_WIDEN_FACTOR = 0.55; // 早期点（轨迹左端）带宽放大系数

// 不确定带半宽（p 单位）。低置信 / 早点 → 更宽；≤2 点带宽极大（连方向都不该断）。
function bandHalf(tier: BandTier, i: number, n: number): number {
  if (n <= 2) return TWO_POINT_BAND_HALF;
  const base = BAND_HALF_BY_TIER[tier];
  const early = 1 + EARLY_WIDEN_FACTOR * (1 - i / (n - 1));
  return Math.min(MAX_BAND_HALF, base * early);
}

export interface TrajPoint {
  x: number;
  y: number;
  /** 该点不确定带上下半宽（p 单位）。 */
  half: number;
}

export interface TrajGeometry {
  pts: TrajPoint[];
  /** 折线 path（n>=1）。n=0 → 空串。 */
  linePath: string;
  /** 不确定带闭合 path（仅 n>=2）。否则空串。 */
  bandPath: string;
  n: number;
}

/**
 * 轨迹几何：p(L) 序列（0..1）→ 折线 path + 不确定带 path + 端点坐标。
 * 单点居中（n===1）；带仅 n>=2 才闭合（单点态改画垂直误差条，由 .tsx 处理）。
 */
export function trajGeometry(
  values: number[],
  tier: BandTier,
  w: number,
  h: number,
  padX: number,
  padY: number,
): TrajGeometry {
  const n = values.length;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const xOf = (i: number) => (n === 1 ? w / 2 : padX + (i * (w - 2 * padX)) / (n - 1));
  const yOf = (p: number) => h - padY - clamp01(p) * (h - 2 * padY);

  const pts: TrajPoint[] = values.map((p, i) => ({
    x: xOf(i),
    y: yOf(p),
    half: bandHalf(tier, i, n),
  }));
  const linePath = pts
    .map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`)
    .join(' ');

  let bandPath = '';
  if (n >= 2) {
    const top = values.map((p, i) => `${pts[i].x.toFixed(1)} ${yOf(p + pts[i].half).toFixed(1)}`);
    const bot = values
      .map((p, i) => `${pts[i].x.toFixed(1)} ${yOf(p - pts[i].half).toFixed(1)}`)
      .reverse();
    bandPath = `M${top.join(' L')} L${bot.join(' L')} Z`;
  }
  return { pts, linePath, bandPath, n };
}
