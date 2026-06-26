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

describe('候选隔离不变量（ADR-0042 2026-06-26 Amendment）— 基值打分层 per-candidate 纯 + batch 无关', () => {
  // X §4.4.4（docs/research/2026-06-25-x-algorithm-deep-dive.md）独立印证此不变量：
  // 基值打分层（mfi/klp/diag）对每个候选的分必须是 (θ̂, b, precision) 的纯函数，
  // 与同批里有哪些其它候选、它们的顺序、批的大小都无关 → 可缓存、replay-safe、
  // 是 YUK-493 同构核 bit-exact replay 的前提。跨候选耦合只允许在三个命名下游层：
  // ① 确定性后置乘子（多样性/疲劳/OON，YUK-370）② IPPS-sampler（softmaxProbabilities）
  // ③ LLM 编排（selection-orchestrator）。θ̂-更新路（θ_global 漂移，YUK-466）显式排除。
  //
  // 这是 guard / 可执行文档：今天基值函数已 per-candidate 纯（标量入标量出），本组测试
  // 把不变量钉死——若日后有人给基值层引入 batch 耦合（如按 batch max 归一化基值分），
  // 这些断言会 FAIL（正是要防的回归）。X 自己只测 mask 结构、缺这个端到端断言，我们补上。
  type Cand = { id: string; thetaHat: number; b: number; precision: number };
  const score = (c: Cand) => ({
    mfi: mfiScore(c.thetaHat, c.b),
    klp: klpScore(c.thetaHat, c.b, c.precision),
    diag: diagnosticScore(c.thetaHat, c.b, c.precision),
  });
  // 模拟基值打分层对一批候选逐条打分（candidate-signals 基值层的纯核）。
  type Scored = ReturnType<typeof score>;
  const scoreBatch = (cands: Cand[]) => new Map(cands.map((c) => [c.id, score(c)]));
  // 显式 throw 取值（避开 biome noNonNullAssertion；缺失即测试 setup bug）。
  const pick = (m: Map<string, Scored>, id: string): Scored => {
    const v = m.get(id);
    if (v === undefined) throw new Error(`candidate ${id} missing from batch score`);
    return v;
  };
  const A: Cand = { id: 'A', thetaHat: 0.3, b: -0.5, precision: 2 };
  const B: Cand = { id: 'B', thetaHat: -1.2, b: 0.8, precision: 0.4 };
  const C: Cand = { id: 'C', thetaHat: 2.1, b: 2.0, precision: 10 };

  it('membership 无关：同一候选的基值分与同批其它候选无关（bit-identical）', () => {
    const solo = pick(scoreBatch([A]), 'A');
    const inPair = pick(scoreBatch([A, B]), 'A');
    const inTriple = pick(scoreBatch([C, A, B]), 'A');
    for (const k of ['mfi', 'klp', 'diag'] as const) {
      expect(Object.is(inPair[k], solo[k])).toBe(true);
      expect(Object.is(inTriple[k], solo[k])).toBe(true);
    }
  });

  it('batch-order 无关：候选在批内的顺序不改任一候选的基值分（bit-identical）', () => {
    const order1 = scoreBatch([A, B, C]);
    const order2 = scoreBatch([C, B, A]);
    for (const id of ['A', 'B', 'C']) {
      const s1 = pick(order1, id);
      const s2 = pick(order2, id);
      for (const k of ['mfi', 'klp', 'diag'] as const) {
        expect(Object.is(s1[k], s2[k])).toBe(true);
      }
    }
  });

  it('扩容/重复无关：加大批、加重复候选不改任一候选基值分（同构核 replay 前提）', () => {
    const small = pick(scoreBatch([A, B]), 'B');
    const large = pick(scoreBatch([A, B, C, A, C, B]), 'B');
    for (const k of ['mfi', 'klp', 'diag'] as const) {
      expect(Object.is(small[k], large[k])).toBe(true);
    }
  });

  it('边界：sampler 层（softmaxProbabilities）是【故意】batch-耦合的 — 在不变量之外', () => {
    // ADR-0042：跨候选耦合只允许在三个命名下游层。softmaxProbabilities 是 sampler 层
    // （减 batch max、除 batch total），故同一首候选的 π_i 必随 batch 组成变——这是预期
    // 且正确的（IPPS 抽样语义）。本断言把边界钉死：基值层纯、sampler 层耦合，二者分明。
    const pFirst_pair = softmaxProbabilities([1.0, 2.0])[0];
    const pFirst_triple = softmaxProbabilities([1.0, 2.0, 5.0])[0];
    expect(pFirst_pair).not.toBeCloseTo(pFirst_triple, 6);
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
