// ====================================================================
// YUK-1058 — D18 评测指标聚合（actual-output eval seal 的 metrics 层）
// ====================================================================
//
// 纯函数、零 IO。输入 = harness 已封存的证据行（EvalEvidenceEntry + corpus
// 期望），输出 = 每 split（dev/holdout/all）的指标块：
//   - error_rate / point_error / severe_error_rate（判分偏离）
//   - upgrade_coverage（Jev/escalation 升级路径覆盖率）
//   - cost / latency（实际花费 + 调用延迟分布）
//
// 「偏离」定义（ticket AC 未钉阈值 —— 取值 = 20% max_points，写进报告让
// review 能对裁决）：
//   - point_error       = mean(|awarded − gold|)（绝对分误差均值）
//   - normalized_error  = mean(|awarded − gold| / max_points)（归一化）
//   - severe_error_rate = 偏离 ≥ SEVERE_ERROR_FRAC·max_points 的 item 占比
//   - error_rate        = 任何偏离（|awarded − gold| > 0）的 item 占比
//
// 语义规则：
//   - 只有 outcome='settled' 且 corpus item 带 expect.gold_points 的证据行参与
//     判分指标；无 gold 的 item 只进 coverage/cost/latency。
//   - 一 item 多 attempt 取【最后一条 settled】为最终判分（retry 语义）。
//   - invoke_failed / gate_rejected 行不进判分指标，但进 invocations/latency
//     （latency 只统计 settled）。
//   - latency_ms 为 null 的行不进延迟分位数。
// ====================================================================

import type { EvalEvidenceEntry } from './d18-harness';

/** 判分期望（corpus item 上的 gold 标注）。 */
export interface D18Expectation {
  /** 满分（该 item 的 scoring-unit 总分）。 */
  max_points: number;
  /** 金标得分（判分偏离的分母/锚）。 */
  gold_points: number;
}

/** 判分严重偏离阈值：|awarded − gold| ≥ SEVERE_ERROR_FRAC × max_points。 */
export const SEVERE_ERROR_FRAC = 0.2;

export interface D18SplitMetrics {
  items_evaluated: number; // 有 settled 判分的 item 数（去重）
  items_with_gold: number; // 其中带 expect.gold_points 的 item 数
  invocations: number; // 全部调用（含 retries / failed / rejected）
  settled_invocations: number;
  failed_invocations: number; // invoke_failed
  gate_rejected_invocations: number;
  retries: number; // attempt > 1 的调用数
  escalated_invocations: number; // escalated=true 的 settled 调用
  upgrade_coverage: number | null; // escalated / settled（settled=0 → null）
  error_rate: number | null; // |awarded − gold| > 0 占比（gold item 集合上）
  severe_error_rate: number | null; // ≥20% max 偏离占比
  point_error: number | null; // mean |awarded − gold|
  normalized_point_error: number | null; // mean |awarded − gold| / max
  cost_usd_total: number; // 全部入账（reported + estimated/unknown 保守值）
  cost_usd_reported: number; // 仅 reported basis
  latency_ms: { p50: number | null; p95: number | null; mean: number | null };
}

export interface D18MetricsReport {
  run_id: string;
  severe_error_threshold_frac: number; // 诚实披露偏离阈值
  splits: {
    dev: D18SplitMetrics;
    holdout: D18SplitMetrics;
    all: D18SplitMetrics;
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function emptySplit(): D18SplitMetrics {
  return {
    items_evaluated: 0,
    items_with_gold: 0,
    invocations: 0,
    settled_invocations: 0,
    failed_invocations: 0,
    gate_rejected_invocations: 0,
    retries: 0,
    escalated_invocations: 0,
    upgrade_coverage: null,
    error_rate: null,
    severe_error_rate: null,
    point_error: null,
    normalized_point_error: null,
    cost_usd_total: 0,
    cost_usd_reported: 0,
    latency_ms: { p50: null, p95: null, mean: null },
  };
}

/**
 * 从已封存证据行 + corpus 期望表聚合指标。
 * `expectations` = item_id → expect（只有带 gold 的 item 需要提供）。
 */
export function computeD18Metrics(
  runId: string,
  entries: readonly EvalEvidenceEntry[],
  expectations: ReadonlyMap<string, D18Expectation>,
): D18MetricsReport {
  const buckets: Record<'dev' | 'holdout' | 'all', EvalEvidenceEntry[]> = {
    dev: [],
    holdout: [],
    all: [],
  };
  for (const e of entries) {
    buckets.all.push(e);
    buckets[e.split].push(e);
  }

  const aggregate = (rows: EvalEvidenceEntry[]): D18SplitMetrics => {
    const m = emptySplit();
    // 每 item 的【最后 settled】判分（retry → attempt 最大者）。
    const finalByItem = new Map<string, EvalEvidenceEntry>();
    const latencies: number[] = [];

    for (const e of rows) {
      m.invocations += 1;
      if (e.attempt > 1) m.retries += 1;
      if (e.outcome === 'settled') {
        m.settled_invocations += 1;
        if (e.escalated === true) m.escalated_invocations += 1;
        if (e.latency_ms !== null) latencies.push(e.latency_ms);
        const prev = finalByItem.get(e.item_id);
        if (prev === undefined || e.attempt > prev.attempt) {
          finalByItem.set(e.item_id, e);
        }
      } else if (e.outcome === 'invoke_failed') {
        m.failed_invocations += 1;
      } else if (e.outcome === 'gate_rejected') {
        m.gate_rejected_invocations += 1;
      }
      // cost：reported 实报 + 其余 basis（estimated/unknown）已在 settle 入保守值——
      // 证据行的 cost_usd 可能为 null（unknown 时 harness 记 null），total 按
      // 「有值即入」计，让报告忠实呈现 evidence 层。未知成本的分摊由 ledger 给。
      if (e.cost_usd !== null) {
        m.cost_usd_total += e.cost_usd;
        if (e.cost_basis === 'reported') m.cost_usd_reported += e.cost_usd;
      }
    }

    m.upgrade_coverage =
      m.settled_invocations === 0 ? null : m.escalated_invocations / m.settled_invocations;

    // 判分指标（只在带 gold 的 item 上）。
    const deviations: number[] = [];
    const normalized: number[] = [];
    let mismatches = 0;
    let severe = 0;
    for (const [itemId, e] of finalByItem) {
      m.items_evaluated += 1;
      const exp = expectations.get(itemId);
      const score = e.score;
      if (exp === undefined || score === null) continue;
      m.items_with_gold += 1;
      const delta = Math.abs(score.points_awarded - exp.gold_points);
      const norm = exp.max_points === 0 ? 0 : delta / exp.max_points;
      deviations.push(delta);
      normalized.push(norm);
      if (delta > 0) mismatches += 1;
      if (norm >= SEVERE_ERROR_FRAC) severe += 1;
    }
    const g = deviations.length;
    if (g > 0) {
      m.error_rate = mismatches / g;
      m.severe_error_rate = severe / g;
      m.point_error = deviations.reduce((a, d) => a + d, 0) / g;
      m.normalized_point_error = normalized.reduce((a, d) => a + d, 0) / g;
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    m.latency_ms = {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      mean: latencies.length === 0 ? null : latencies.reduce((a, l) => a + l, 0) / latencies.length,
    };
    return m;
  };

  return {
    run_id: runId,
    severe_error_threshold_frac: SEVERE_ERROR_FRAC,
    splits: {
      dev: aggregate(buckets.dev),
      holdout: aggregate(buckets.holdout),
      all: aggregate(buckets.all),
    },
  };
}
