// YUK-519 (A7) — effectiveness-trend 的**纯趋势数学**（无 DB / 无 schema 依赖）。
//
// 从 effectiveness-trend.ts 抽出，让安全关键的「方向 + 置信」判定逻辑可在 no-DB unit 车道
// 单测（effectiveness-trend.ts 经 mastery-progress-signal 传递依赖 @/db/client，无法落 unit
// 分区；本模块零 DB import，故可）。读模型仍从这里 import 同一套函数——单一真相，无漂移。
//
// ⑥硬约束（gate doc §1.5.2 ⑥ + ADR-0035 §决定1）：趋势 delta **绝不裸数字**。只输出**定性
// 方向**（rising/holding/falling/insufficient）+ **置信档**（low/medium/high）。置信是「别把
// 噪声画成确定上升」的执行机制——故它本身是契约里安全关键的一半，必须有回归保护。

// ── 趋势判定常量（documented thresholds，可调，与 calibration-maturity 对齐处已注明）──────
//
// MIN_EVENTS_FOR_TREND：低于此样本量连方向都不断言（→ `insufficient`）。= 4，对齐
//   calibration-maturity.ts 的 COLD_START_EVIDENCE_FLOOR（= theta.ts coldStartN）——冷启段
//   内 θ̂ 由先验主导、噪声大，不该被当成已收敛的趋势。
//
// FIRM_TREND_EVIDENCE：趋势要够「笃定」(high 置信)需要的样本量。趋势是 delta 的 delta，
//   不确定性叠加，故取冷启 floor 的 2×（= 8）——光逃离冷启不够，要再积累才敢给 high。
//
// HOLDING_BAND_THETA：早窗 vs 近窗 θ̂ 均值差落在 ±此带内 = `holding`（θ̂ 在 logit 尺度，
//   0.05 logits 的窗间漂移视作实质持平）。带外才判 rising/falling。
//
// EFFECT_RATIO_{MEDIUM,HIGH}：非持平方向的「信噪比」门槛——|窗间差| / θ̂ 标准差。一条微弱
//   上升即便 n 高也只配 medium；要 effect 显著盖过噪声才给 high。守住 ⑥硬约束「别把噪声
//   画成确定的上升」。
export const MIN_EVENTS_FOR_TREND = 4;
export const FIRM_TREND_EVIDENCE = 8;
export const HOLDING_BAND_THETA = 0.05;
export const EFFECT_RATIO_MEDIUM = 0.5;
export const EFFECT_RATIO_HIGH = 1.0;

// 主导方向卷起时「同向占比」高置信门槛 + credible KC 数下限。
export const ROLLUP_AGREE_HIGH = 0.75;
export const ROLLUP_AGREE_MEDIUM = 0.5;

export type TrendDirection = 'rising' | 'holding' | 'falling' | 'insufficient';
export type TrendConfidence = 'low' | 'medium' | 'high';

/** 一条 p(L)/θ̂ 轨迹点（直接来自一条 mastery_progress 事件的 payload + created_at）。 */
export interface EffectivenessTrendPoint {
  /** 事件 created_at（ISO 字符串）——纵向时间轴。 */
  at: string;
  /** 当次 attempt 的 difficulty-aware p(L) point estimate（0..1）。payload 缺/非数 → null。 */
  p_learned: number | null;
  /** 当次 attempt 的 θ̂ 绝对值（趋势计算的锚）。payload 缺/非数 → null。 */
  theta_hat: number | null;
  /** 当次 attempt 的 Δθ̂；首作答前为 null（冷启无 prior Δ）。⑥硬约束：不直接呈现裸值。 */
  theta_delta: number | null;
}

export interface EffectivenessTrendSummary {
  direction: TrendDirection;
  confidence: TrendConfidence;
  /** 趋势建立在几次有效（θ̂ 非空）作答上。 */
  span_evidence: number;
  /**
   * 该 KC 是否有可信的 mastery 趋势可呈现（A7 owner 决策的 UI 路由信号）：
   * true → UI 画掌握度趋势；false（证据不足 / θ̂ 全空的退化态）→ UI 改走活动量代理，
   * 不假装掌握度趋势。
   */
  has_mastery_signal: boolean;
}

export function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 总体标准差（population sd）。少于 2 点 → 0。 */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

/**
 * 早窗 vs 近窗 θ̂ 均值比较 → 方向 + 置信。
 *
 * 简单稳健（owner 哲学：最小充分）：取等长的最早 half 与最近 half（n 为奇数则跳过中点），
 * 比较两窗 θ̂ 均值差。用 θ̂（logit 尺度、线性、非饱和）而非 p(L)（被 sigmoid 在 0/1 处压扁，
 * 等量 θ̂ 增益产出不等量 p(L) 增益）。
 *   - 方向 = 窗间差点估计：落 ±HOLDING_BAND_THETA 内 → holding；带外按符号 rising/falling。
 *   - 置信 = 对方向判定的信任度（与方向正交）：样本量(n) + 信噪比(|差|/θ̂ sd)。持平态下高 n =
 *     高置信「确实平」；上升/下降态要 effect 盖过噪声才给 high（守 ⑥硬约束）。
 */
export function summarizeTrend(points: EffectivenessTrendPoint[]): EffectivenessTrendSummary {
  const thetas = points.map((p) => p.theta_hat).filter((t): t is number => t !== null);
  const n = thetas.length;

  if (n < MIN_EVENTS_FOR_TREND) {
    // 证据太少连方向都不断言——⑥硬约束第 3 条：insufficient 是一等公民态。退化态（θ̂ 全空 →
    // n=0）也落这里 → has_mastery_signal=false → UI 走活动量代理。
    return {
      direction: 'insufficient',
      confidence: 'low',
      span_evidence: n,
      has_mastery_signal: false,
    };
  }

  const half = Math.floor(n / 2);
  const earlyMean = mean(thetas.slice(0, half));
  const nearMean = mean(thetas.slice(n - half));
  const diff = nearMean - earlyMean;
  const sd = stddev(thetas);
  // 信噪比：窗间差相对 θ̂ 离散度。sd=0（全等）时：有差→Infinity（确定），无差→0。
  const ratio = sd > 0 ? Math.abs(diff) / sd : Math.abs(diff) > 0 ? Number.POSITIVE_INFINITY : 0;

  let direction: TrendDirection;
  if (Math.abs(diff) <= HOLDING_BAND_THETA) {
    direction = 'holding';
  } else {
    direction = diff > 0 ? 'rising' : 'falling';
  }

  let confidence: TrendConfidence;
  if (direction === 'holding') {
    // 持平：信任来自样本量——数据越多越确定「它真的平」。
    confidence = n >= FIRM_TREND_EVIDENCE ? 'high' : 'medium';
  } else if (n >= FIRM_TREND_EVIDENCE && ratio >= EFFECT_RATIO_HIGH) {
    confidence = 'high';
  } else if (ratio >= EFFECT_RATIO_MEDIUM) {
    confidence = 'medium';
  } else {
    // 微弱 / 噪声级移动——⑥硬约束：别把它当笃定趋势。
    confidence = 'low';
  }

  return { direction, confidence, span_evidence: n, has_mastery_signal: true };
}

/**
 * 主导方向 + 卷起置信：在一组有可信信号的 KC 趋势上选众数方向（rising/holding/falling）。
 *
 * 纯函数（无 DB），供 per-subject 卷起用。无任何 credible KC（全退化/冷启）→ insufficient/low，
 * 让 UI 走活动量代理。卷起置信由主导方向的**同向占比** + credible KC 数门槛给。
 */
export function rollupSubjectDirection(trends: EffectivenessTrendSummary[]): {
  direction: TrendDirection;
  confidence: TrendConfidence;
} {
  const credible = trends.filter((t) => t.has_mastery_signal);
  if (credible.length === 0) {
    return { direction: 'insufficient', confidence: 'low' };
  }
  const counts: Record<'rising' | 'holding' | 'falling', number> = {
    rising: 0,
    holding: 0,
    falling: 0,
  };
  for (const t of credible) {
    if (t.direction === 'rising' || t.direction === 'holding' || t.direction === 'falling') {
      counts[t.direction] += 1;
    }
  }
  // 众数方向（确定性 tiebreak：rising > holding > falling 的稳定顺序）。
  const order: Array<'rising' | 'holding' | 'falling'> = ['rising', 'holding', 'falling'];
  let direction: 'rising' | 'holding' | 'falling' = order[0];
  for (const d of order) {
    if (counts[d] > counts[direction]) direction = d;
  }
  // 卷起置信：主导方向的同向占比 → 一致性越高越可信，并受 credible KC 数封顶。
  const agree = counts[direction] / credible.length;
  let confidence: TrendConfidence;
  if (credible.length >= MIN_EVENTS_FOR_TREND && agree >= ROLLUP_AGREE_HIGH) {
    confidence = 'high';
  } else if (agree >= ROLLUP_AGREE_MEDIUM) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }
  return { direction, confidence };
}
