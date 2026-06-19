// YUK-361 Phase 1 — selection-signals 纯策略数学单测（no-DB，unit 分区）。
// 断言来自 roadmap §Task4 Step4 + uncertaintyPenalty/diagnosticScore 边界。

import { describe, expect, it } from 'vitest';
import {
  diagnosticScore,
  klpScore,
  mfiScore,
  softmaxProbabilities,
  uncertaintyPenalty,
} from './selection-signals';
import { fisherInformation, thetaSe } from './theta';

describe('mfiScore', () => {
  it('θ̂ = b 时取最大值 0.25', () => {
    expect(mfiScore(0, 0)).toBeCloseTo(0.25, 10);
    expect(mfiScore(2, 2)).toBeCloseTo(0.25, 10);
  });

  it('θ̂ 远离 b 时信息量下降', () => {
    expect(mfiScore(4, 0)).toBeLessThan(mfiScore(0, 0));
    expect(mfiScore(-4, 0)).toBeLessThan(mfiScore(0, 0));
  });

  it('对称：θ̂−b 等距时信息量相等', () => {
    expect(mfiScore(2, 0)).toBeCloseTo(mfiScore(-2, 0), 10);
  });

  it('恒在 (0, 0.25]', () => {
    for (const [t, b] of [
      [0, 0],
      [5, 0],
      [-5, 0],
      [1, -3],
    ]) {
      const v = mfiScore(t, b);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(0.25);
    }
  });
});

describe('uncertaintyPenalty', () => {
  it('precision 越高降权因子越大（趋近 1）', () => {
    expect(uncertaintyPenalty(100)).toBeGreaterThan(uncertaintyPenalty(1));
    expect(uncertaintyPenalty(1)).toBeGreaterThan(uncertaintyPenalty(0.01));
  });

  it('恒在 (0, 1)', () => {
    for (const p of [0.01, 1, 4, 100, 1e6]) {
      const v = uncertaintyPenalty(p);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('precision = 1（弱先验）时为 0.5', () => {
    // √1 / (1+√1) = 1/2
    expect(uncertaintyPenalty(1)).toBeCloseTo(0.5, 10);
  });

  it('非正 precision 被 clamp 不抛错', () => {
    expect(() => uncertaintyPenalty(0)).not.toThrow();
    expect(() => uncertaintyPenalty(-5)).not.toThrow();
    expect(uncertaintyPenalty(0)).toBeGreaterThanOrEqual(0);
  });
});

describe('diagnosticScore', () => {
  it('= mfiScore × uncertaintyPenalty', () => {
    const [t, b, prec] = [0.5, 0, 4];
    expect(diagnosticScore(t, b, prec)).toBeCloseTo(mfiScore(t, b) * uncertaintyPenalty(prec), 12);
  });

  it('高不确定 θ̂ 被降权：同 MFI 下 precision 低者诊断分更低', () => {
    expect(diagnosticScore(0, 0, 0.1)).toBeLessThan(diagnosticScore(0, 0, 100));
  });
});

describe('softmaxProbabilities', () => {
  it('空输入返回空数组', () => {
    expect(softmaxProbabilities([])).toEqual([]);
  });

  it('等分数 → 均匀分布', () => {
    expect(softmaxProbabilities([1, 1])).toEqual([0.5, 0.5]);
  });

  it('高分得到更高概率', () => {
    const p = softmaxProbabilities([2, 1]);
    expect(p[0]).toBeGreaterThan(p[1]);
  });

  it('概率和为 1', () => {
    const p = softmaxProbabilities([3, 1, 0.5, -2]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('温度越低越尖锐', () => {
    const sharp = softmaxProbabilities([2, 1], 0.1);
    const soft = softmaxProbabilities([2, 1], 2);
    expect(sharp[0]).toBeGreaterThan(soft[0]);
  });

  it('数值稳定：大分数不溢出', () => {
    const p = softmaxProbabilities([1000, 999]);
    expect(p.every((x) => Number.isFinite(x))).toBe(true);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('temperature ≤ 0 抛错（除零 / 负温反转排序的护栏）', () => {
    expect(() => softmaxProbabilities([2, 1], 0)).toThrow(/temperature must be > 0/);
    expect(() => softmaxProbabilities([2, 1], -1)).toThrow(/temperature must be > 0/);
  });

  it('非有限 score 抛错（不静默产出全 NaN 的 π_i）', () => {
    expect(() => softmaxProbabilities([1, Number.NaN])).toThrow(/non-finite score/);
    expect(() => softmaxProbabilities([Number.POSITIVE_INFINITY, 0])).toThrow(/non-finite score/);
  });

  it('超大候选集不爆栈（不用 Math.max(...spread)）', () => {
    const big = new Array(200_000).fill(0).map((_, i) => i % 7);
    expect(() => softmaxProbabilities(big)).not.toThrow();
  });
});

// A3 (YUK-435) — KLP（posterior-weighted Fisher grid integral）冷启信息分。
describe('klpScore', () => {
  // Reference implementation mirrors the spec exactly: 21-point grid over
  // θ̂ ± 3·SE, Gaussian posterior weights φ((θ−θ̂)/SE), weighted mean of
  // fisherInformation(θ, b). Used as the ground-truth oracle for the unit.
  function referenceKlp(thetaHat: number, b: number, thetaPrecision: number): number {
    const se = thetaSe(thetaPrecision);
    const lo = thetaHat - 3 * se;
    const hi = thetaHat + 3 * se;
    const N = 21;
    const step = (hi - lo) / (N - 1);
    let num = 0;
    let den = 0;
    for (let i = 0; i < N; i++) {
      const theta = lo + i * step;
      const z = (theta - thetaHat) / se;
      const w = Math.exp(-0.5 * z * z);
      num += w * fisherInformation(theta, b);
      den += w;
    }
    return num / den;
  }

  it('与 21 点后验加权 Fisher 网格积分参考实现一致', () => {
    for (const [t, b, prec] of [
      [0, 0, 1],
      [0.5, 0.85, 0.5],
      [-1.2, 0.3, 2],
      [2, -1, 0.25],
    ]) {
      expect(klpScore(t, b, prec)).toBeCloseTo(referenceKlp(t, b, prec), 12);
    }
  });

  it('恒在 (0, 0.25]（item information 的取值域，加权平均不出界）', () => {
    for (const [t, b, prec] of [
      [0, 0, 1],
      [3, 0, 0.5],
      [-3, 0, 0.5],
      [1, -2, 4],
    ]) {
      const v = klpScore(t, b, prec);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(0.25);
    }
  });

  it('低 precision（高不确定）时与点 MFI 偏离更大', () => {
    // θ̂ = b：点 MFI 在峰值 0.25；后验把质量摊到两侧信息更低的 θ ⇒ KLP < MFI，
    // 且 precision 越低（SE 越宽）摊得越开 ⇒ 偏离越大。
    const b = 0;
    const thetaHat = 0;
    const pointMfi = mfiScore(thetaHat, b); // 0.25 峰值
    const klpWide = klpScore(thetaHat, b, 0.25); // 宽后验（SE=2）
    const klpNarrow = klpScore(thetaHat, b, 100); // 窄后验（SE=0.1）
    expect(klpWide).toBeLessThan(pointMfi);
    expect(klpNarrow).toBeLessThan(pointMfi);
    // 偏离单调：宽后验偏离 > 窄后验偏离。
    expect(pointMfi - klpWide).toBeGreaterThan(pointMfi - klpNarrow);
  });

  it('高 precision（SE→0）时收敛到点 MFI', () => {
    // precision 极大 ⇒ SE 极小 ⇒ 网格塌到 θ̂ 一点 ⇒ KLP → fisherInformation(θ̂, b)。
    const [t, b] = [0.4, 0.85];
    expect(klpScore(t, b, 1e6)).toBeCloseTo(mfiScore(t, b), 6);
  });

  it('对称：θ̂−b 等距时 KLP 相等（后验关于 θ̂ 对称 + I(θ) 关于 b 对称）', () => {
    // 同一 precision，θ̂ 在 b 两侧等距 ⇒ 网格 + 权重 + I 都镜像对称 ⇒ KLP 相等。
    expect(klpScore(2, 0, 1)).toBeCloseTo(klpScore(-2, 0, 1), 12);
  });

  it('非正 precision 被 clamp（thetaSe floor）不抛错、不 NaN', () => {
    expect(() => klpScore(0, 0, 0)).not.toThrow();
    const v = klpScore(0, 0, 0);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });
});
