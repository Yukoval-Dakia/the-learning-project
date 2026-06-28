// YUK-354 (A7 成效趋势面) — web client for the effectiveness-trend read model.
// Hits GET /api/observability/effectiveness-trend (registered in
// observability/manifest.ts), the per-KC / per-subject longitudinal mastery-delta
// surface (server/effectiveness-trend.ts — pure drizzle, zero write path).
//
// 横截面诊断看 calibration-maturity（「现在多准」）；本面看纵向 delta（「相比过去涨了吗」
// = 方向 + 置信）。前后端分离：读模型挂 observability 包，用户面落 Coach 复盘中枢。
//
// Types are kept STRICTLY in lock-step with the server response shape
// (EffectivenessTrendResponse / Series / SubjectTrendRollup / Aggregate in
// server/effectiveness-trend.ts + server/effectiveness-trend-summary.ts). The
// client re-declares (does NOT import the server module, which pulls @/db/client)
// so the field names/types here must mirror the server or the panel breaks.

import { apiJson } from '@/ui/lib/api';

export type TrendDirection = 'rising' | 'holding' | 'falling' | 'insufficient';
export type TrendConfidence = 'low' | 'medium' | 'high';

/** 一条 p(L)/θ̂ 轨迹点（来自一条 mastery_progress 事件的 payload + created_at）。 */
export interface EffectivenessTrendPoint {
  /** 事件 created_at（ISO 字符串）——纵向时间轴。 */
  at: string;
  /** 当次 attempt 的 difficulty-aware p(L) point estimate（0..1）。payload 缺/非数 → null。 */
  p_learned: number | null;
  /** 当次 attempt 的 θ̂ 绝对值。payload 缺/非数 → null。 */
  theta_hat: number | null;
  /** 当次 attempt 的 Δθ̂；首作答前为 null。⑥硬约束：UI 绝不直接渲染裸值。 */
  theta_delta: number | null;
}

export interface EffectivenessTrendSummary {
  direction: TrendDirection;
  confidence: TrendConfidence;
  /** 趋势建立在几次有效（θ̂ 非空）作答上。证据量 ≠ delta，可如实渲染。 */
  span_evidence: number;
  /**
   * 该 KC 是否有可信的 mastery 趋势可呈现（A7 owner 决策的 UI 路由信号）：
   * true → 画掌握度趋势；false（证据不足 / θ̂ 全空的退化态）→ UI 走活动量代理，
   * 不假装掌握度趋势。
   */
  has_mastery_signal: boolean;
}

export interface EffectivenessTrendSeries {
  knowledge_id: string;
  /** KC 名。KC 行缺失（已删）→ null。 */
  name: string | null;
  /** 派生科目轴（knowledge.domain → 沿 parent 链继承的 effective_domain）。无 → null。 */
  effective_domain: string | null;
  /** 按 created_at 升序的轨迹点。 */
  points: EffectivenessTrendPoint[];
  trend: EffectivenessTrendSummary;
  /** 该 KC 的 mastery_progress 事件总数 = 活动量代理（退化态下的兜底信号）。 */
  activity_count: number;
}

export interface SubjectTrendRollup {
  effective_domain: string | null;
  /** 该科目下有活动的 KC 中主导趋势方向；无可信信号 → `insufficient`。 */
  direction: TrendDirection;
  confidence: TrendConfidence;
  /** 该科目下有 mastery_progress 活动的 KC 数。 */
  kc_count: number;
  /** 其中有可信 mastery 趋势的 KC 数。0 → 退化/冷启，走活动量代理。 */
  kc_with_mastery_signal: number;
  /** 该科目下 mastery_progress 事件总数 = 活动量代理。 */
  activity_count: number;
}

export interface EffectivenessTrendAggregate {
  total_kcs_with_activity: number;
  total_events: number;
  /** 沿 effective_domain 派生轴的整科卷起（含 null-domain「未归类」桶，server 末尾排）。 */
  by_subject: SubjectTrendRollup[];
}

export interface EffectivenessTrendResponse {
  series: EffectivenessTrendSeries[];
  aggregate: EffectivenessTrendAggregate;
}

export const getEffectivenessTrend = () =>
  apiJson<EffectivenessTrendResponse>('/api/observability/effectiveness-trend');
