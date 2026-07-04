// YUK-361 Phase 6 (Task 11) — active-PPI 重标定纯函数单测（aipwMean 正确归一化 /
// effectiveB read-compat / impliedBLabel IRT 反推 / PPI++ λ* power-tuning）。
// 无 DB——label hook + recalibrateQuestion 的 db 测在 recalibration.db.test.ts。

import { describe, expect, it } from 'vitest';

import { expectedScore } from '@/core/theta';
import { isObserved } from '@/server/mastery/state';
import {
  IPW_WEIGHT_CAP_C,
  type LabeledResidual,
  type LabeledSample,
  RECALIBRATION_MIN_LABELS,
  aipwMean,
  cappedIpwWeights,
  effectiveB,
  estimateLambdaStar,
  impliedBLabel,
  ppiPlusMean,
} from './recalibration';

// ─────────────────────────────────────────────────────────────────────────────
// aipwMean — ADR-0043 §7 + Hájek 自归一化（FINDING #1：校正项 ÷ 精确 Σ(1/π)，不是 ÷N、
// 不是 ÷round(Σ1/π)、不是 ÷n_labeled 再 ÷π）。
// ─────────────────────────────────────────────────────────────────────────────
describe('aipwMean (ADR-0043 §7 + Hájek self-normalization, FINDING #1)', () => {
  it('no labels → pure pool prediction mean (correction term = 0)', () => {
    expect(aipwMean([1, 2, 3], [])).toBeCloseTo(2, 12);
    expect(aipwMean([0.5], [])).toBeCloseTo(0.5, 12);
  });

  it('uniform sampling does NOT multiply by N/n twice (the §7 bug)', () => {
    // 候选池锚预测全 0.6（predictionMean=0.6）。均匀抽样 π=0.2。已标注 2 条，残差 ξ=+0.4 各一条
    // （label=1.0, m̂=0.6）。Hájek：predictionMean + Σ(ξ/π)/Σ(1/π)
    //   = 0.6 + (0.4/0.2 + 0.4/0.2)/(1/0.2 + 1/0.2) = 0.6 + (2+2)/(5+5) = 0.6 + 0.4 = 1.0
    // （均匀 π 下 Σ1/π = N=10，故 Hájek 与旧 ÷N 形数值巧合一致——这正是旧测遮住 FINDING #1 的原因）。
    const pool = Array(10).fill(0.6);
    const labeled: LabeledResidual[] = [
      { residual: 0.4, pi: 0.2 },
      { residual: 0.4, pi: 0.2 },
    ];
    const correct = aipwMean(pool, labeled);
    expect(correct).toBeCloseTo(1.0, 12);

    // 朴素错误形（÷n_labeled 再保留 ÷π 隐含的 N/n 因子）：0.6 + (1/2)·(2+2) = 2.6 —— 过度校正。
    const naiveWrong = 0.6 + labeled.reduce((s, r) => s + r.residual / r.pi, 0) / labeled.length;
    expect(naiveWrong).toBeCloseTo(2.6, 12);
    expect(correct).not.toBeCloseTo(naiveWrong, 1);
  });

  it('Hájek self-normalization: pool SIZE is irrelevant (only predictionMean matters)', () => {
    // FINDING #1 core: the IPW correction divides by Σ(1/π) (the exact weight sum), NOT the
    // pool size. So two pools with the SAME predictionMean but DIFFERENT lengths give the
    // SAME result — proving no round(Σ1/π) / Array(N).fill dependence remains.
    const labeled: LabeledResidual[] = [
      { residual: 0.3, pi: 0.13 },
      { residual: 0.3, pi: 0.47 },
      { residual: 0.3, pi: 0.9 },
    ];
    const small = aipwMean([0.6], labeled);
    const large = aipwMean(Array(100).fill(0.6), labeled);
    expect(small).toBeCloseTo(large, 12);
  });

  it('all-equal residuals + non-uniform π → exact recovery (the bias the old ÷round(Σ1/π) hid)', () => {
    // Every label says ξ = +1.0 (e.g. label 1.5, anchor 0.5). Hájek: 0.5 + (Σ 1/π)/(Σ 1/π) = 1.5
    // EXACTLY, independent of the π distribution. The old round(Σ1/π) denominator gave ≈1.513.
    const pis = [0.12, 0.34, 0.55, 0.2, 0.8, 0.45, 0.6];
    const labeled: LabeledResidual[] = pis.map((pi) => ({ residual: 1.0, pi }));
    expect(aipwMean([0.5], labeled)).toBeCloseTo(1.5, 12);
    // Demonstrate the old buggy form would NOT have recovered 1.5:
    const sumInv = pis.reduce((a, p) => a + 1 / p, 0);
    const oldBuggy = 0.5 + labeled.reduce((s, r) => s + r.residual / r.pi, 0) / Math.round(sumInv);
    expect(oldBuggy).not.toBeCloseTo(1.5, 3);
  });

  it('known case: hand-computed Hájek expected value', () => {
    // pool predictionMean=1.5。labeled 3 条：ξ/π = -0.5/0.5=-1.0, 0.3/0.6=0.5, 1.2/0.4=3.0 → Σ=2.5。
    // Σ1/π = 2 + 1.6667 + 2.5 = 6.16667。Hájek = 1.5 + 2.5/6.16667 = 1.905405…
    const pool = [1, 1, 2, 2];
    const labeled: LabeledResidual[] = [
      { residual: -0.5, pi: 0.5 },
      { residual: 0.3, pi: 0.6 },
      { residual: 1.2, pi: 0.4 },
    ];
    const sumInv = 1 / 0.5 + 1 / 0.6 + 1 / 0.4;
    expect(aipwMean(pool, labeled)).toBeCloseTo(1.5 + 2.5 / sumInv, 12);
  });

  it('throws on π <= 0 (positivity, §7)', () => {
    expect(() => aipwMean([1, 2], [{ residual: 0.1, pi: 0 }])).toThrow(/positivity/i);
    expect(() => aipwMean([1, 2], [{ residual: 0.1, pi: -0.3 }])).toThrow(/positivity/i);
  });

  it('throws on π = Infinity (positivity finiteness, C7)', () => {
    // 非有限 π（Infinity）→ throw。1/∞=0 会静默给该样本零权重（污染 Hájek 分母），必须 fail-fast。
    expect(() => aipwMean([1, 2], [{ residual: 0.1, pi: Number.POSITIVE_INFINITY }])).toThrow(
      /finite/i,
    );
  });

  it('throws on empty pool (N=0 → undefined mean)', () => {
    expect(() => aipwMean([], [])).toThrow(/non-empty/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ppiPlusMean — λ 泛化；λ=1 数值等于 aipwMean。
// ─────────────────────────────────────────────────────────────────────────────
describe('ppiPlusMean (PPI++ power-tuning)', () => {
  it('λ=1 equals aipwMean (residual = label − m̂)', () => {
    const bAnchor = 0.6;
    const N = 10;
    const pool = Array(N).fill(bAnchor);
    const samples: LabeledSample[] = [
      { label: 1.0, prediction: bAnchor, pi: 0.2 },
      { label: 1.0, prediction: bAnchor, pi: 0.2 },
    ];
    const residuals: LabeledResidual[] = samples.map((s) => ({
      residual: s.label - s.prediction,
      pi: s.pi,
    }));
    expect(ppiPlusMean(pool, samples, 1)).toBeCloseTo(aipwMean(pool, residuals), 12);
  });

  it('λ=0 degrades to classical Hájek IPW label mean (anchor fully ignored)', () => {
    // λ=0 → 0·predictionMean + Σ(label/π)/Σ(1/π)。锚 m̂ 被完全忽略（Hájek 自归一化）。
    const pool = Array(10).fill(99); // 锚预测极端值，λ=0 时应不影响结果。
    const samples: LabeledSample[] = [
      { label: 0.5, prediction: 99, pi: 0.2 },
      { label: 0.5, prediction: 99, pi: 0.2 },
    ];
    // Σ(0.5/0.2)/Σ(1/0.2) = (2.5+2.5)/(5+5) = 5/10 = 0.5（与 π 分布无关，全 label 相等 → 精确 0.5）。
    expect(ppiPlusMean(pool, samples, 0)).toBeCloseTo(0.5, 12);
  });

  it('throws on π <= 0 (positivity)', () => {
    expect(() => ppiPlusMean([1], [{ label: 1, prediction: 0.5, pi: 0 }], 1)).toThrow(
      /positivity/i,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateLambdaStar — 好锚 → λ*→1，坏锚 → λ*→0（自降级）。
// ─────────────────────────────────────────────────────────────────────────────
describe('estimateLambdaStar (PPI++ anchor-quality auto-degrade)', () => {
  it('< 2 samples → 1 (degenerate, trust anchor)', () => {
    expect(estimateLambdaStar([])).toBe(1);
    expect(estimateLambdaStar([{ label: 0.5, prediction: 0.4, pi: 0.5 }])).toBe(1);
  });

  it('good anchor (prediction perfectly correlated with label) → λ* ≈ 1', () => {
    // label = prediction + const → Cov/Var = 1.
    const samples: LabeledSample[] = [
      { label: 0.1, prediction: 0.0, pi: 0.5 },
      { label: 0.3, prediction: 0.2, pi: 0.5 },
      { label: 0.6, prediction: 0.5, pi: 0.5 },
      { label: 1.0, prediction: 0.9, pi: 0.5 },
    ];
    expect(estimateLambdaStar(samples)).toBeCloseTo(1, 6);
  });

  it('bad anchor (prediction uncorrelated / anti-correlated with label) → λ* clamps toward 0', () => {
    // label anti-correlated with prediction → raw λ* < 0 → clamp 0.
    const samples: LabeledSample[] = [
      { label: 1.0, prediction: 0.0, pi: 0.5 },
      { label: 0.7, prediction: 0.3, pi: 0.5 },
      { label: 0.3, prediction: 0.7, pi: 0.5 },
      { label: 0.0, prediction: 1.0, pi: 0.5 },
    ];
    expect(estimateLambdaStar(samples)).toBe(0);
  });

  it('anchor has no variance (homogeneous pool) → 1 (trust anchor)', () => {
    // FINDING low-1: this is EXACTLY the single-question constant-anchor mode recalibrateQuestion
    // runs in — every sample's m̂ = b_anchor (constant) → Var(m̂)=0 → λ*=1. The bad-anchor
    // auto-degrade valve is therefore inert in single-question mode regardless of how the
    // labels spread; it only engages once Phase 7+ supplies a NON-constant m̂.
    const samples: LabeledSample[] = [
      { label: 0.2, prediction: 0.5, pi: 0.5 },
      { label: 0.9, prediction: 0.5, pi: 0.5 },
    ];
    expect(estimateLambdaStar(samples)).toBe(1);
  });

  it('throws on π <= 0 (positivity)', () => {
    expect(() =>
      estimateLambdaStar([
        { label: 0.5, prediction: 0.4, pi: 0.5 },
        { label: 0.6, prediction: 0.5, pi: -0.1 },
      ]),
    ).toThrow(/positivity/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YUK-558 — median-相对 IPW 截权（spec Q1-C / M1）。数值杠杆断言（非散文），回滚恒等，
// 凸组合保持，no-op-on-同质，λ*==1 inert-in-phase。
// ─────────────────────────────────────────────────────────────────────────────
describe('cappedIpwWeights (median-relative IPW cap, YUK-558 M1)', () => {
  it('no-op on homogeneous input: capped == uncapped bit-for-bit + clipped=0', () => {
    // 全-moderate-π（无权重 > C·median）→ 截权不 bind。
    const pis = [0.5, 0.4, 0.6, 0.5, 0.45];
    const { weights, clipped } = cappedIpwWeights(pis);
    const raw = pis.map((p) => 1 / p);
    expect(clipped).toBe(0);
    for (let i = 0; i < pis.length; i++) expect(weights[i]).toBe(raw[i]);
  });

  it('rollback identity: C = Infinity ⇒ weights === raw 1/π bit-for-bit, clipped=0', () => {
    // 回滚旋钮 = Number.POSITIVE_INFINITY：cap 永不 bind ⇒ 精确还原旧行为。
    const pis = [0.5, 0.5, 0.5, 4e-4]; // 含一条极端 fluke——正常 C=4 会截，∞ 不截。
    const { weights, clipped } = cappedIpwWeights(pis, Number.POSITIVE_INFINITY);
    const raw = pis.map((p) => 1 / p);
    expect(clipped).toBe(0);
    for (let i = 0; i < pis.length; i++) expect(weights[i]).toBe(raw[i]);
  });

  it('caps a single fluke to C·median(w) and counts the activation', () => {
    // 11 honest @π=0.5（w=2）+ 1 fluke @π=4e-4（w=2500）。median=2、cap=C·2=8。fluke 截 2500→8。
    const pis = [...Array(11).fill(0.5), 4e-4];
    const { weights, clipped } = cappedIpwWeights(pis);
    expect(clipped).toBe(1);
    expect(weights[11]).toBeCloseTo(IPW_WEIGHT_CAP_C * 2, 12); // C·median = 8
    for (let i = 0; i < 11; i++) expect(weights[i]).toBe(2); // honest 不动
  });

  it('even-length heterogeneous batch: median = mean of two middle order stats (kills sorted[mid] regression, C8②)', () => {
    // pis=[0.5,0.25,0.2,0.02] → raw=[2,4,5,50]。median=quantile(0.5)=avg(sorted[1],sorted[2])=avg(4,5)
    // =4.5（type-7 偶数取中两点均值），**非** sorted[mid=2]=5。cap=C·4.5=18 → 50 截到 18。
    // 若误用 sorted[mid] 给 median=5 → cap=20 → weights[3]=20≠18 → 本测击杀该回归。
    const pis = [0.5, 0.25, 0.2, 0.02];
    const { weights, clipped } = cappedIpwWeights(pis);
    expect(clipped).toBe(1);
    expect(weights[3]).toBe(18); // C·median = 4·4.5 = 18（sorted[mid] 会误给 20）
    expect(weights[0]).toBe(2);
    expect(weights[1]).toBe(4);
    expect(weights[2]).toBe(5); // 未截
  });

  it('k≥2 concurrent flukes erode aggregate mass; k≥n/2 median jump defeats the cap (C6 honest failure mode)', () => {
    // k=2 flukes（10 honest @π=0.5 w=2 + 2 flukes @π=4e-4）：median=2、cap=8 → 两 fluke 皆截。
    // 聚合质量 = 2·8 / (10·2 + 2·8) = 16/36 ≈ 44.4% = kC/(kC+n−k)（k=2,C=4,n=12 → 8/18）。
    const k2 = [...Array(10).fill(0.5), 4e-4, 4e-4];
    const r2 = cappedIpwWeights(k2);
    expect(r2.clipped).toBe(2);
    const cap2 = IPW_WEIGHT_CAP_C * 2;
    const total2 = r2.weights.reduce((a, w) => a + w, 0);
    const flukeMass2 = (r2.weights[10] + r2.weights[11]) / total2;
    expect(flukeMass2).toBeCloseTo((2 * IPW_WEIGHT_CAP_C) / (2 * IPW_WEIGHT_CAP_C + 10), 12); // 8/18
    expect(flukeMass2).toBeCloseTo(0.4444, 4);
    expect(cap2).toBe(8);

    // k=6 flukes（≥ n/2）：6 honest w=2 + 6 flukes w=2500。median=avg(sorted[5],sorted[6])=avg(2,2500)
    // =1251 → cap=4·1251=5004 > 2500 ⇒ **一条也不截**。median 被 fluke 抬跳 ⇒ cap 彻底失效（诚实钉）。
    const k6 = [...Array(6).fill(0.5), ...Array(6).fill(4e-4)];
    const r6 = cappedIpwWeights(k6);
    expect(r6.clipped).toBe(0);
  });
});

describe('ppiPlusMean median-relative cap (YUK-558 M1, quantitative leverage)', () => {
  // 11 honest labels @π=0.5 (w=2, label=0.0) + 1 fluke @π=4e-4 (label=+2.0)。b_anchor=0 ⇒
  // predictionMean=0 ⇒ b_calib = Σ(label·w)/Σw = 标签的 Hájek 加权均值。
  const samples: LabeledSample[] = [
    ...Array(11)
      .fill(null)
      .map(() => ({ label: 0.0, prediction: 0.0, pi: 0.5 })),
    { label: 2.0, prediction: 0.0, pi: 4e-4 },
  ];
  const pool = [0.0];

  it('capped fluke self-normalized mass ≤ C/(C+n−1) ⇒ b_calib ≈ 0.53 < 0.6', () => {
    // cap=8 → Σw=11·2+8=30 → b_calib=(2.0·8)/30=16/30≈0.5333。fluke 质量 8/30≈26.7% = 4/15。
    const bCalib = ppiPlusMean(pool, samples, 1);
    expect(bCalib).toBeCloseTo(16 / 30, 12);
    expect(bCalib).toBeLessThan(0.6);
    // 杠杆闭式上界从**实际 estimator 输出反导**（非硬编码代数恒等式重言，C8⑤）：honest 标签全 0
    // ⇒ b_calib = flukeMass·2.0（唯一非零贡献是 fluke）⇒ impliedMass = bCalib/2.0 是 estimator
    // 实测的 fluke 自归一化质量。断它 ≤ C/(C+n−1)（n=12 → C/(C+11)）。
    const impliedMass = bCalib / 2.0;
    expect(impliedMass).toBeLessThanOrEqual(IPW_WEIGHT_CAP_C / (IPW_WEIGHT_CAP_C + 11) + 1e-12);
  });

  it('uncapped (C=Infinity) fluke dominates ⇒ b_calib ≈ 1.98 > 1.9 (rollback contrast)', () => {
    const bCalibUncapped = ppiPlusMean(pool, samples, 1, Number.POSITIVE_INFINITY);
    expect(bCalibUncapped).toBeCloseTo(5000 / 2522, 9); // (2.0·2500)/(22+2500)
    expect(bCalibUncapped).toBeGreaterThan(1.9);
  });

  it('estimator-level rollback identity: ppiPlusMean(…, C=∞) === pre-YUK-558 division-form bit-for-bit (C4)', () => {
    // C4：未截项走 xi/π **单舍入**（与旧实现逐位一致）。内联旧公式复刻（pre-YUK-558 除法形），随机
    // π/label/λ 批断 ppiPlusMean(pool, samples, λ, ∞) === old（toBe 逐位）。C=∞ ⇒ 无一截 ⇒ 全走除法分支。
    const oldDivisionForm = (
      poolPredictions: number[],
      labeled: LabeledSample[],
      lambda: number,
    ): number => {
      const predictionMean = poolPredictions.reduce((a, b) => a + b, 0) / poolPredictions.length;
      let correction = 0;
      let weightSum = 0;
      for (const s of labeled) {
        correction += (s.label - lambda * s.prediction) / s.pi; // 除法形（单舍入）
        weightSum += 1 / s.pi;
      }
      return lambda * predictionMean + (weightSum > 0 ? correction / weightSum : 0);
    };
    for (let trial = 0; trial < 50; trial++) {
      const n = 3 + Math.floor(Math.random() * 10);
      const poolN = 1 + Math.floor(Math.random() * 5);
      const rndPool = Array.from({ length: poolN }, () => Math.random() * 2 - 1);
      const rndSamples: LabeledSample[] = Array.from({ length: n }, () => ({
        label: Math.random() * 4 - 2,
        prediction: Math.random() * 2 - 1,
        pi: Math.max(1e-4, Math.random()), // ∈ (0,1]
      }));
      const lambda = Math.random();
      expect(ppiPlusMean(rndPool, rndSamples, lambda, Number.POSITIVE_INFINITY)).toBe(
        oldDivisionForm(rndPool, rndSamples, lambda),
      );
    }
  });

  it('throws on π = Infinity (positivity finiteness, C7)', () => {
    expect(() =>
      ppiPlusMean([1], [{ label: 1, prediction: 0.5, pi: Number.POSITIVE_INFINITY }], 1),
    ).toThrow(/finite/i);
  });

  it('convex combination preserved: capped b_calib ∈ [min label, max label] (λ=1 constant anchor)', () => {
    const mixed: LabeledSample[] = [
      { label: -1.2, prediction: 0.0, pi: 0.3 },
      { label: 0.4, prediction: 0.0, pi: 0.7 },
      { label: 1.8, prediction: 0.0, pi: 0.05 }, // low-π outlier
      { label: 0.1, prediction: 0.0, pi: 0.5 },
      { label: -0.6, prediction: 0.0, pi: 0.6 },
    ];
    const bCalib = ppiPlusMean([0.0], mixed, 1);
    const labels = mixed.map((s) => s.label);
    expect(bCalib).toBeGreaterThanOrEqual(Math.min(...labels));
    expect(bCalib).toBeLessThanOrEqual(Math.max(...labels));
  });
});

describe('estimateLambdaStar cap is inert in constant-anchor phase (YUK-558 M1)', () => {
  it('constant anchor + heterogeneous π (incl. fluke) → still returns 1 (Var(m̂)=0 early-return before capped moments)', () => {
    // 单题常数锚模式：所有 prediction=b_anchor（常数）⇒ Var(m̂)=0 ⇒ return 1 先于加权矩，截权 no-op。
    const samples: LabeledSample[] = [
      { label: 0.2, prediction: 0.5, pi: 0.5 },
      { label: 0.9, prediction: 0.5, pi: 0.5 },
      { label: 2.0, prediction: 0.5, pi: 4e-4 }, // fluke π——即便截权也不改 Var(m̂)=0。
    ];
    expect(estimateLambdaStar(samples)).toBe(1);
    expect(estimateLambdaStar(samples, Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('constant anchor ∈ {0.1, 0.7, -0.3} × C ∈ {4, ∞} → λ* === 1 (short-circuit precedes moments, C1)', () => {
    // C1 独立 bug 修复：常数锚短路**真正先于**加权矩（旧 `!(varM>0)` 守卫在矩后、可被 FP 噪声
    // 逃逸——mBar 求和舍入 ≈1e-17 ⇒ varM≈1e-31>0 ⇒ 吐垃圾 λ*）。fixture = 11 honest @π=0.5 +
    // 1 fluke @π=4e-4，prediction 全 = anchor（同一变量，严格相等）⇒ 每锚 × 每 C 都短路返回 1。
    for (const anchor of [0.1, 0.7, -0.3]) {
      const samples: LabeledSample[] = [
        ...Array(11)
          .fill(null)
          .map(() => ({ label: 0.0, prediction: anchor, pi: 0.5 })),
        { label: 2.0, prediction: anchor, pi: 4e-4 },
      ];
      expect(estimateLambdaStar(samples)).toBe(1);
      expect(estimateLambdaStar(samples, Number.POSITIVE_INFINITY)).toBe(1);
    }
  });

  it('throws on π = Infinity (positivity finiteness, C7)', () => {
    // n≥2 才过 n<2 早返、进 positivity 循环。非有限 π（Infinity）→ throw（1/π=0 会静默污染 IPW）。
    expect(() =>
      estimateLambdaStar([
        { label: 0.5, prediction: 0.4, pi: 0.5 },
        { label: 0.6, prediction: 0.5, pi: Number.POSITIVE_INFINITY },
      ]),
    ).toThrow(/finite/i);
  });
});

describe('IPW_WEIGHT_CAP_C domain pin (YUK-558 M3)', () => {
  it('IPW_WEIGHT_CAP_C > 1 (cap must bind above the batch median, not below)', () => {
    expect(IPW_WEIGHT_CAP_C).toBeGreaterThan(1);
  });
  it('RECALIBRATION_MIN_LABELS ≥ 1 and integer', () => {
    expect(RECALIBRATION_MIN_LABELS).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(RECALIBRATION_MIN_LABELS)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// effectiveB — read-compat 优先链 b_calib ?? b_anchor ?? b。
// ─────────────────────────────────────────────────────────────────────────────
describe('effectiveB (read-compat precedence)', () => {
  it('null/undefined row → null', () => {
    expect(effectiveB(null)).toBe(null);
    expect(effectiveB(undefined)).toBe(null);
  });

  it('b_calib set → b_calib wins over b_anchor and b', () => {
    expect(effectiveB({ b: 0.1, b_anchor: 0.2, b_calib: 0.9 })).toBe(0.9);
  });

  it('b_calib null → falls to b_anchor (NO-OP today)', () => {
    expect(effectiveB({ b: 0.1, b_anchor: 0.7, b_calib: null })).toBe(0.7);
  });

  it('b_calib + b_anchor null → falls to legacy b', () => {
    expect(effectiveB({ b: 0.3, b_anchor: null, b_calib: null })).toBe(0.3);
  });

  it('all null → null (cold start, no anchor)', () => {
    expect(effectiveB({ b: null, b_anchor: null, b_calib: null })).toBe(null);
  });

  it('b_calib=0 is a real value, not falsy-skipped (?? semantics)', () => {
    expect(effectiveB({ b: 0.5, b_anchor: 0.4, b_calib: 0 })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// impliedBLabel — 锚定 θ̂ 的 IRT 反推难度标签（§6，非裸 outcome）。
// ─────────────────────────────────────────────────────────────────────────────
describe('impliedBLabel (anchored-θ IRT-derived difficulty label, §6)', () => {
  it('wrong answer (outcome=0) → b_label > b_anchor (题对此人更难)', () => {
    const bAnchor = 0;
    const theta = 0; // p=σ(0)=0.5
    expect(impliedBLabel(theta, bAnchor, 0)).toBeGreaterThan(bAnchor);
  });

  it('correct answer (outcome=1) → b_label < b_anchor (题对此人更易)', () => {
    const bAnchor = 0;
    const theta = 0;
    expect(impliedBLabel(theta, bAnchor, 1)).toBeLessThan(bAnchor);
  });

  it('symmetric at θ=b_anchor (p=0.5): correct/wrong offsets are mirror images', () => {
    const bAnchor = 0.5;
    const theta = 0.5; // p=0.5, fisher=0.25
    // residual = ∓(outcome−0.5)/0.25 = ∓0.5/0.25 = ∓2.0（但 MAX_RESIDUAL_LOGIT=2.0，恰在界）
    const wrong = impliedBLabel(theta, bAnchor, 0); // +2.0 → b_anchor+2.0
    const correct = impliedBLabel(theta, bAnchor, 1); // -2.0 → b_anchor-2.0
    expect(wrong - bAnchor).toBeCloseTo(-(correct - bAnchor), 10);
  });

  it('is anchored: b_label tracks b_anchor (shifting anchor shifts label)', () => {
    const theta = 0.2;
    const a = impliedBLabel(theta, 0.0, 1);
    const b = impliedBLabel(theta, 1.0, 1);
    // 不同锚 → 不同 label（fixed-anchor 反推，label 随锚平移 + 残差项随 p 变）。
    expect(a).not.toBeCloseTo(b, 6);
  });

  it('uses the 1PL ICC p = σ(θ − b_anchor) (consistency with expectedScore)', () => {
    // 间接核验：当 θ 远高于 b_anchor（学习者强）答对，p→1，残差≈0，b_label≈b_anchor
    // （强者答对几乎不携带难度信息——fisher→0 但 clamp 兜住，残差量级小）。
    const bAnchor = 0;
    const theta = 5; // p≈1
    expect(expectedScore(theta, bAnchor)).toBeGreaterThan(0.99);
    const label = impliedBLabel(theta, bAnchor, 1);
    // 答对一道远低于能力的题 → label 略低于锚但不极端（clamp 内）。
    expect(label).toBeLessThanOrEqual(bAnchor);
    expect(label).toBeGreaterThan(bAnchor - 2.0001);
  });
});

// YUK-559 (S1 / C8) — the state.ts provenance discriminant helper (co-located with the
// mastery unit tests). observed KC row → true; KG-borrowed inferred entry → false.
describe('isObserved — MasteryProjection provenance discriminant', () => {
  it('provenance "observed" → true, "inferred" → false', () => {
    expect(isObserved({ provenance: 'observed' })).toBe(true);
    expect(isObserved({ provenance: 'inferred' })).toBe(false);
  });
});
