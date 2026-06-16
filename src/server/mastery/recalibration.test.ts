// YUK-361 Phase 6 (Task 11) — active-PPI 重标定纯函数单测（aipwMean 正确归一化 /
// effectiveB read-compat / impliedBLabel IRT 反推 / PPI++ λ* power-tuning）。
// 无 DB——label hook + recalibrateQuestion 的 db 测在 recalibration.db.test.ts。

import { describe, expect, it } from 'vitest';

import { expectedScore } from '@/core/theta';
import {
  type LabeledResidual,
  type LabeledSample,
  aipwMean,
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
