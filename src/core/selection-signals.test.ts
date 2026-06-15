// YUK-361 Phase 1 — selection-signals 纯策略数学单测（no-DB，unit 分区）。
// 断言来自 roadmap §Task4 Step4 + uncertaintyPenalty/diagnosticScore 边界。

import { describe, expect, it } from 'vitest';
import {
  diagnosticScore,
  mfiScore,
  softmaxProbabilities,
  uncertaintyPenalty,
} from './selection-signals';

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
});
