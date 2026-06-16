// YUK-361 Phase 3 Step C1 — sampler 单测（UNIT，无 DB）。
//
// 命名 *.unit.test.ts → 由 fastTestInclude 的 `src/capabilities/**/*.unit.test.ts`
// 约定 glob 接管，落 no-DB unit 分区（无需登记 allowlist）。
//
// 核心证明：Monte Carlo 测——经验入选频率 ≈ 记录的 π_i，客观验证记录的 π_i 是
// 真随机抽样的 inclusion probability（ADR-0043 §7）。

import { softmaxProbabilities } from '@/core/selection-signals';
import { describe, expect, it } from 'vitest';
import {
  type WeightedCandidate,
  inclusionProbabilities,
  sampleByWeight,
} from './selection-sampler';

// 确定性 PRNG（mulberry32）。**不用 Math.random**：测试需可复现。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T = 0.25;

// Assertion-free Map lookup (repo Biome forbids non-null assertions, incl. tests).
function getOr(m: Map<string, number>, k: string): number {
  const v = m.get(k);
  if (v === undefined) throw new Error(`missing key ${k}`);
  return v;
}

describe('inclusionProbabilities (Poisson IPPS clip, pure)', () => {
  it('empty → []', () => {
    expect(inclusionProbabilities([], 3)).toEqual([]);
  });

  it('targetCount ≥ N → all π_i = 1', () => {
    const pi = inclusionProbabilities([0.1, 0.3, 0.6], 3);
    expect(pi).toEqual([1, 1, 1]);
    const piOver = inclusionProbabilities([0.1, 0.3, 0.6], 5);
    expect(piOver).toEqual([1, 1, 1]);
  });

  it('targetCount ≤ 0 → all π_i = 0', () => {
    expect(inclusionProbabilities([0.2, 0.3, 0.5], 0)).toEqual([0, 0, 0]);
    expect(inclusionProbabilities([0.2, 0.3, 0.5], -2)).toEqual([0, 0, 0]);
  });

  it('Σ π_i = targetCount exactly (uniform q, no clipping)', () => {
    const q = [0.25, 0.25, 0.25, 0.25];
    const pi = inclusionProbabilities(q, 2);
    const sum = pi.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(2, 10);
    // uniform q + no clip ⇒ each π_i = 2/4 = 0.5
    for (const p of pi) expect(p).toBeCloseTo(0.5, 10);
  });

  it('Σ π_i = targetCount even when clipping locks dominant items', () => {
    // One huge q forces a clip to 1; the remainder redistributes.
    const q = [0.9, 0.05, 0.03, 0.02];
    const pi = inclusionProbabilities(q, 2);
    const sum = pi.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(2, 10);
    expect(pi[0]).toBe(1); // dominant item clipped to certainty
    // remaining 1.0 of expected count spread over the other three by their q
    expect(pi[1]).toBeGreaterThan(pi[2]);
    expect(pi[2]).toBeGreaterThan(pi[3]);
    for (const p of pi.slice(1)) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('every entry stays within [0,1]', () => {
    const q = [0.5, 0.2, 0.2, 0.05, 0.05];
    const pi = inclusionProbabilities(q, 3);
    for (const p of pi) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('sampleByWeight', () => {
  it('empty candidates → []', () => {
    expect(sampleByWeight([], { temperature: T, targetCount: 3, rng: mulberry32(1) })).toEqual([]);
  });

  it('targetCount ≥ N → all included with π_i = 1', () => {
    const cands: WeightedCandidate[] = [
      { refId: 'a', weight: 1 },
      { refId: 'b', weight: 5 },
      { refId: 'c', weight: 2 },
    ];
    const out = sampleByWeight(cands, { temperature: T, targetCount: 3, rng: mulberry32(7) });
    expect(out.map((s) => s.refId).sort()).toEqual(['a', 'b', 'c']);
    for (const s of out) expect(s.inclusionProbability).toBe(1);
  });

  it('rejects temperature ≤ 0 (delegated to softmaxProbabilities guard)', () => {
    const cands: WeightedCandidate[] = [
      { refId: 'a', weight: 1 },
      { refId: 'b', weight: 2 },
    ];
    expect(() => sampleByWeight(cands, { temperature: 0, targetCount: 1 })).toThrow();
    expect(() => sampleByWeight(cands, { temperature: -0.5, targetCount: 1 })).toThrow();
  });

  it('positivity: weight ≥ 0 and T > 0 ⇒ π_i > 0 for selected items', () => {
    // Even a zero-weight candidate gets q_i > 0 (softmax) ⇒ π_i > 0.
    const cands: WeightedCandidate[] = [
      { refId: 'big', weight: 10 },
      { refId: 'zero', weight: 0 },
      { refId: 'mid', weight: 3 },
    ];
    // Force every item to be sampled by an rng that always returns ~0.
    const out = sampleByWeight(cands, { temperature: T, targetCount: 2, rng: () => 0 });
    // rng()===0 < π_i selects every item with π_i > 0.
    for (const s of out) expect(s.inclusionProbability).toBeGreaterThan(0);
    expect(out.map((s) => s.refId).sort()).toEqual(['big', 'mid', 'zero']);
  });

  it('higher weight → higher π_i (monotonic in weight)', () => {
    const cands: WeightedCandidate[] = [
      { refId: 'lo', weight: 1 },
      { refId: 'mid', weight: 3 },
      { refId: 'hi', weight: 8 },
    ];
    // Sample with rng()=0 so all are selected and each item's π_i is exposed.
    const out = sampleByWeight(cands, { temperature: T, targetCount: 2, rng: () => 0 });
    const byId = new Map(out.map((s) => [s.refId, s.inclusionProbability]));
    expect(getOr(byId, 'hi')).toBeGreaterThanOrEqual(getOr(byId, 'mid'));
    expect(getOr(byId, 'mid')).toBeGreaterThanOrEqual(getOr(byId, 'lo'));
  });

  it('temperature monotonicity: lower T → π_i more concentrated on top-weight candidate', () => {
    // targetCount=1 keeps total expected mass at 1 so NO item saturates to π=1 at
    // either temperature — the comparison reflects pure softmax sharpening, not clipping.
    const cands: WeightedCandidate[] = [
      { refId: 'top', weight: 2 },
      { refId: 'a', weight: 1 },
      { refId: 'b', weight: 0.5 },
      { refId: 'c', weight: 0 },
    ];
    const piOf = (temp: number) => {
      const out = sampleByWeight(cands, { temperature: temp, targetCount: 1, rng: () => 0 });
      return new Map(out.map((s) => [s.refId, s.inclusionProbability]));
    };
    const sharp = piOf(0.5); // low T = sharper
    const flat = piOf(2.0); // high T = flatter
    // No clipping at targetCount=1: top π stays < 1 at both temperatures.
    expect(getOr(sharp, 'top')).toBeLessThan(1);
    // Lower T concentrates inclusion mass on the top-weight item.
    expect(getOr(sharp, 'top')).toBeGreaterThan(getOr(flat, 'top'));
    // And pulls mass away from the lowest-weight item.
    expect(getOr(sharp, 'c')).toBeLessThan(getOr(flat, 'c'));
  });
});

describe('Monte Carlo: empirical inclusion frequency ≈ recorded π_i (THE correctness proof)', () => {
  it('over N=20000 draws, each candidate appears with frequency ≈ its reported π_i', () => {
    // Weights + T chosen so all π_i land in an observable range (~0.12 .. ~0.91,
    // no saturation to 1, none vanishing to ~0) — this is the regime where the
    // empirical-vs-recorded match is a meaningful proof for EVERY candidate.
    const cands: WeightedCandidate[] = [
      { refId: 'a', weight: 1.0 },
      { refId: 'b', weight: 0.7 },
      { refId: 'c', weight: 0.4 },
      { refId: 'd', weight: 0.2 },
      { refId: 'e', weight: 0.0 },
    ];
    const targetCount = 2;
    const mcTemp = 0.5; // higher T than module default → non-saturating regime
    const N = 20000;
    const rng = mulberry32(123456);

    const counts = new Map<string, number>(cands.map((c) => [c.refId, 0]));
    // The sampler recomputes the SAME π vector every call (deterministic in inputs),
    // so capture the reported π_i from selected items as we go.
    const reportedPi = new Map<string, number>();

    for (let i = 0; i < N; i++) {
      const out = sampleByWeight(cands, { temperature: mcTemp, targetCount, rng });
      for (const s of out) {
        counts.set(s.refId, getOr(counts, s.refId) + 1);
        reportedPi.set(s.refId, s.inclusionProbability);
      }
    }

    // Every candidate must have been selected at least once (positivity ⇒ π_i > 0).
    for (const c of cands) {
      expect(reportedPi.has(c.refId)).toBe(true);
    }

    // Empirical frequency must match the recorded π_i within tolerance — the
    // defining property of Poisson sampling (marginal inclusion prob = π_i).
    for (const c of cands) {
      const empirical = getOr(counts, c.refId) / N;
      const recorded = getOr(reportedPi, c.refId);
      expect(empirical).toBeCloseTo(recorded, 1); // |diff| < 0.05
      expect(Math.abs(empirical - recorded)).toBeLessThan(0.02); // tighter ±0.02
    }

    // Cross-check the reported π against the pure helper directly (same temperature).
    const q = softmaxProbabilities(
      cands.map((c) => c.weight),
      mcTemp,
    );
    const piDirect = inclusionProbabilities(q, targetCount);
    cands.forEach((c, idx) => {
      expect(getOr(reportedPi, c.refId)).toBeCloseTo(piDirect[idx], 10);
    });

    // Σ π_i ≈ targetCount (scheme size property).
    const sumPi = piDirect.reduce((a, b) => a + b, 0);
    expect(sumPi).toBeCloseTo(targetCount, 6);
  });
});
