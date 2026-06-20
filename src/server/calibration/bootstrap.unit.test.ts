// TASK 8 — paired whole-KC cluster bootstrap CI for ΔAUC.
// Sources: Field & Welsh, JRSS-B 2007; Cameron, Gelbach & Miller, REStat 2008.
// Deterministic via injected mulberry32. Resample whole CLUSTERS (KCs), never rows.

import { describe, expect, it } from 'vitest';
import { type ClusterForwardPreds, deltaAucClusterBootstrap } from './bootstrap';
import { mulberry32 } from './rng';

// Build a cluster where SRT scores rank outcomes BETTER than binary, but neither is
// perfect (so AUC_binary < AUC_srt < 1 → a measurable positive ΔAUC). The binary score
// is a heavily-overlapping noisy signal (low AUC); the SRT score is well-separated but
// with enough overlap that AUC < 1 (so the bootstrap CI is non-degenerate).
function strongCluster(n: number, seed: number): ClusterForwardPreds {
  const rng = mulberry32(seed);
  const scoresSrt: number[] = [];
  const scoresBinary: number[] = [];
  const labels: (0 | 1)[] = [];
  for (let i = 0; i < n; i++) {
    const label: 0 | 1 = rng() < 0.5 ? 1 : 0;
    labels.push(label);
    // binary score: heavy overlap → weak ranking (AUC well below 1). Signal 0.10 vs
    // noise spanning 0.6 → classes substantially overlap.
    scoresBinary.push(0.5 + (label === 1 ? 0.05 : -0.05) + (rng() - 0.5) * 0.6);
    // srt score: clearer separation (signal 0.30) but overlapping noise span 0.4 so
    // AUC_srt < 1 → strictly between AUC_binary and 1.
    scoresSrt.push(0.5 + (label === 1 ? 0.15 : -0.15) + (rng() - 0.5) * 0.4);
  }
  return { scoresSrt, scoresBinary, labels };
}

describe('deltaAucClusterBootstrap', () => {
  it('strong SRT signal → pointDelta > 0.02 and CI excludes 0', () => {
    const clusters = Array.from({ length: 20 }, (_, i) => strongCluster(8, 1000 + i));
    const r = deltaAucClusterBootstrap(clusters, { b: 500, rng: mulberry32(42) });
    expect(r.pointDelta).toBeGreaterThan(0.02);
    expect(r.excludesZero).toBe(true);
    expect(r.ciLo).toBeGreaterThan(0);
  });

  it('null signal (srt === binary) → pointDelta ≈ 0, CI does NOT exclude 0', () => {
    const clusters: ClusterForwardPreds[] = Array.from({ length: 20 }, (_, i) => {
      const rng = mulberry32(2000 + i);
      const scores: number[] = [];
      const labels: (0 | 1)[] = [];
      for (let j = 0; j < 8; j++) {
        labels.push(rng() < 0.5 ? 1 : 0);
        scores.push(rng());
      }
      return { scoresSrt: scores, scoresBinary: [...scores], labels };
    });
    const r = deltaAucClusterBootstrap(clusters, { b: 500, rng: mulberry32(7) });
    expect(Math.abs(r.pointDelta)).toBeLessThan(1e-9);
    expect(r.excludesZero).toBe(false);
  });

  it('determinism: same seed → identical CI', () => {
    const clusters = Array.from({ length: 15 }, (_, i) => strongCluster(6, 3000 + i));
    const a = deltaAucClusterBootstrap(clusters, { b: 300, rng: mulberry32(99) });
    const b = deltaAucClusterBootstrap(clusters, { b: 300, rng: mulberry32(99) });
    expect(a.ciLo).toBe(b.ciLo);
    expect(a.ciHi).toBe(b.ciHi);
    expect(a.pointDelta).toBe(b.pointDelta);
  });

  it('degenerate replicates are counted, not silently backfilled (M1)', () => {
    // Tiny clusters that frequently resample to a single-class pool → some replicates degenerate.
    const clusters: ClusterForwardPreds[] = [
      { scoresSrt: [0.9, 0.1], scoresBinary: [0.6, 0.4], labels: [1, 0] },
      { scoresSrt: [0.8], scoresBinary: [0.55], labels: [1] },
      { scoresSrt: [0.2], scoresBinary: [0.45], labels: [0] },
    ];
    const r = deltaAucClusterBootstrap(clusters, { b: 200, rng: mulberry32(5) });
    expect(r.degenerateReplicates).toBeGreaterThan(0);
    expect(r.degenerateFraction).toBeGreaterThan(0);
    // b reflects only non-degenerate replicates actually used
    expect(r.b).toBeLessThanOrEqual(200);
  });

  it('all-one-class pool → pointDelta NaN', () => {
    const clusters: ClusterForwardPreds[] = [
      { scoresSrt: [0.9, 0.8], scoresBinary: [0.6, 0.5], labels: [1, 1] },
      { scoresSrt: [0.7], scoresBinary: [0.55], labels: [1] },
    ];
    const r = deltaAucClusterBootstrap(clusters, { b: 100, rng: mulberry32(1) });
    expect(Number.isNaN(r.pointDelta)).toBe(true);
  });

  it('pairing: aucSrt and aucBinary computed on the SAME resampled multiset', () => {
    // With identical srt/binary scores, every paired replicate Δ* must be exactly 0,
    // so the CI is degenerate at 0 — proves the two AUCs share the resample draw.
    const clusters: ClusterForwardPreds[] = Array.from({ length: 12 }, (_, i) => {
      const rng = mulberry32(4000 + i);
      const scores: number[] = [];
      const labels: (0 | 1)[] = [];
      for (let j = 0; j < 6; j++) {
        labels.push(rng() < 0.5 ? 1 : 0);
        scores.push(rng());
      }
      return { scoresSrt: scores, scoresBinary: [...scores], labels };
    });
    const r = deltaAucClusterBootstrap(clusters, { b: 300, rng: mulberry32(11) });
    expect(r.ciLo).toBeCloseTo(0, 12);
    expect(r.ciHi).toBeCloseTo(0, 12);
  });
});
