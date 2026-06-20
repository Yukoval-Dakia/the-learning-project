// Paired whole-KC cluster bootstrap CI for ΔAUC = AUC_SRT − AUC_binary.
//
// Sources: cluster bootstrap (Field & Welsh, "Bootstrapping clustered data", JRSS-B
//   2007; Cameron, Gelbach & Miller, "Bootstrap-based improvements for inference with
//   clustered errors", REStat 2008).
//
// ⚠ RESAMPLE WHOLE KCs (clusters), NEVER individual rows. The forward predictions for
//   one KC are serially correlated (a rising θ̂ trajectory); an i.i.d. row bootstrap
//   would UNDERESTIMATE the variance → a falsely narrow CI → a false PASS. Resampling
//   whole clusters preserves the within-KC serial correlation inside each resampled
//   cluster, which is the cross-cutting evidence-inflation fix the dossier calls for.
//
// ⚠ PAIRED. Each replicate draws ONE set of clusters and computes BOTH AUC_SRT* and
//   AUC_binary* on the SAME resampled (score,label) multiset. The shared sampling noise
//   cancels in Δ* = AUC_SRT* − AUC_binary*, so the CI reflects the SRT-vs-binary
//   contrast, not the (large) sampling variance of either AUC alone. Independent
//   resampling of the two would inflate the CI and mask a real effect.
//
// PURE (given an injected rng) — no IO, no DB.

import { forwardAuc } from './auc';

/** One cluster = one KC: its forward predictions under both variants, plus labels. */
export interface ClusterForwardPreds {
  scoresSrt: number[];
  scoresBinary: number[];
  labels: (0 | 1)[];
}

export interface DeltaAucCi {
  /** AUC_SRT − AUC_binary on the full pooled sample; NaN if either pool AUC is null. */
  pointDelta: number;
  aucSrt: number | null;
  aucBinary: number | null;
  /** percentile CI lower bound (2.5%) over non-degenerate replicates. */
  ciLo: number;
  /** percentile CI upper bound (97.5%). */
  ciHi: number;
  /** replicates actually used (non-degenerate). */
  b: number;
  /** replicates discarded because a resampled pool had a single class (M1). */
  degenerateReplicates: number;
  /** degenerate / attempted (M1 — reported, NOT silently backfilled). */
  degenerateFraction: number;
  /** ciLo > 0 — the decision criterion for "ΔAUC excludes 0". */
  excludesZero: boolean;
}

const MAX_POOLED_N_BEFORE_REDUCE = 5000;
const REDUCED_B = 500;

function poolScores(
  clusters: ClusterForwardPreds[],
  which: 'srt' | 'binary',
): {
  scores: number[];
  labels: (0 | 1)[];
} {
  const scores: number[] = [];
  const labels: (0 | 1)[] = [];
  for (const c of clusters) {
    const src = which === 'srt' ? c.scoresSrt : c.scoresBinary;
    for (let i = 0; i < src.length; i++) {
      scores.push(src[i]);
      labels.push(c.labels[i]);
    }
  }
  return { scores, labels };
}

/**
 * Paired cluster bootstrap CI for ΔAUC.
 *
 * @param clusters one entry per KC (the bootstrap unit).
 * @param opts.b   number of bootstrap replicates (default 2000). Reduced to 500 with a
 *   surfaced `b` when the pooled N exceeds 5000 (the O(n²) AUC × B would be too slow).
 * @param opts.rng injected [0,1) RNG (mulberry32) for reproducibility.
 */
export function deltaAucClusterBootstrap(
  clusters: ClusterForwardPreds[],
  opts: { b?: number; rng: () => number },
): DeltaAucCi {
  const rng = opts.rng;
  const k = clusters.length;

  // ── Point estimate on the full pooled sample ──
  const pooledSrt = poolScores(clusters, 'srt');
  const pooledBinary = poolScores(clusters, 'binary');
  const aucSrtRes = forwardAuc(pooledSrt.scores, pooledSrt.labels);
  const aucBinaryRes = forwardAuc(pooledBinary.scores, pooledBinary.labels);
  const aucSrt = aucSrtRes.auc;
  const aucBinary = aucBinaryRes.auc;
  const pointDelta = aucSrt !== null && aucBinary !== null ? aucSrt - aucBinary : Number.NaN;

  // m3 guard: shrink B on a large pooled sample so the O(n²) AUC × B stays tractable.
  const pooledN = pooledSrt.scores.length;
  let bTarget = opts.b ?? 2000;
  if (pooledN > MAX_POOLED_N_BEFORE_REDUCE && bTarget > REDUCED_B) {
    bTarget = REDUCED_B;
  }

  // ── Paired cluster bootstrap ──
  const deltas: number[] = [];
  let degenerate = 0;
  let attempted = 0;

  if (k > 0) {
    for (let rep = 0; rep < bTarget; rep++) {
      attempted++;
      // Resample K cluster INDICES with replacement (whole-KC bootstrap).
      const drawn: number[] = new Array(k);
      for (let i = 0; i < k; i++) {
        drawn[i] = Math.floor(rng() * k);
      }

      // Pool the resampled clusters' predictions — SAME draw for srt and binary (paired).
      const srtScores: number[] = [];
      const binScores: number[] = [];
      const labels: (0 | 1)[] = [];
      for (const ci of drawn) {
        const c = clusters[ci];
        for (let i = 0; i < c.labels.length; i++) {
          srtScores.push(c.scoresSrt[i]);
          binScores.push(c.scoresBinary[i]);
          labels.push(c.labels[i]);
        }
      }

      const aSrt = forwardAuc(srtScores, labels);
      const aBin = forwardAuc(binScores, labels);
      if (aSrt.auc === null || aBin.auc === null) {
        // Degenerate replicate (single-class pool). COUNT it, do NOT redraw to backfill
        // B — silent redraw biases the CI toward less-degenerate (more balanced) samples.
        degenerate++;
        continue;
      }
      deltas.push(aSrt.auc - aBin.auc);
    }
  }

  const usableB = deltas.length;
  const degenerateFraction = attempted > 0 ? degenerate / attempted : 0;

  // ── Percentile CI ──
  let ciLo = Number.NaN;
  let ciHi = Number.NaN;
  if (usableB > 0) {
    const sorted = [...deltas].sort((a, b) => a - b);
    ciLo = percentile(sorted, 0.025);
    ciHi = percentile(sorted, 0.975);
  }

  return {
    pointDelta,
    aucSrt,
    aucBinary,
    ciLo,
    ciHi,
    b: usableB,
    degenerateReplicates: degenerate,
    degenerateFraction,
    excludesZero: Number.isFinite(ciLo) && ciLo > 0,
  };
}

/** Linear-interpolated percentile of a pre-sorted ascending array. */
function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sortedAsc[0];
  // index in [0, n-1]
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}
