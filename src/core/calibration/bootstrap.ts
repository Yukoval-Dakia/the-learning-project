// Paired whole-KC bootstrap CI for ΔAUC. Field & Welsh, JRSS-B 2007; Cameron, Gelbach
// & Miller, REStat 2008.
// Resample whole KCs. Predictions inside one KC are serially correlated, so a row
// bootstrap underestimates the variance and can false-PASS.
// Each replicate scores both AUCs on the same draw. Independent draws would inflate
// the CI and hide a real contrast.

import { forwardAuc } from './auc';

/** One cluster = one KC: its forward predictions under both variants, plus labels. */
export interface ClusterForwardPreds {
  scoresSrt: number[];
  scoresBinary: number[];
  labels: (0 | 1)[];
}

export interface DeltaAucCi {
  /** NaN when either pooled AUC is null. */
  pointDelta: number;
  aucSrt: number | null;
  aucBinary: number | null;
  ciLo: number;
  ciHi: number;
  /** Non-degenerate replicates only. A single-class draw is counted, not redrawn. */
  b: number;
  degenerateReplicates: number;
  degenerateFraction: number;
  excludesZero: boolean;
}

const MAX_POOLED_N_BEFORE_REDUCE = 5000;
const REDUCED_B = 500;
// A second tier. Cost is O(N²) per replicate, so one step-down at 5000 is not enough.
// Fewer replicates widen the error of the CI endpoints. They do not bias ΔAUC.
const HARD_POOLED_N_BEFORE_REDUCE = 20000;
const HARD_REDUCED_B = 200;

/** Exported so the cap can be tested without paying the O(N²) bootstrap. */
export function resolveBootstrapB(pooledN: number, requestedB: number): number {
  if (pooledN > HARD_POOLED_N_BEFORE_REDUCE && requestedB > HARD_REDUCED_B) {
    return HARD_REDUCED_B;
  }
  if (pooledN > MAX_POOLED_N_BEFORE_REDUCE && requestedB > REDUCED_B) {
    return REDUCED_B;
  }
  return requestedB;
}

/** The three parallel arrays are one observation. A length mismatch would pair the wrong scores. */
function assertClusterAligned(c: ClusterForwardPreds, clusterIndex: number): void {
  const n = c.labels.length;
  if (c.scoresSrt.length !== n || c.scoresBinary.length !== n) {
    throw new Error(
      `cluster ${clusterIndex}: scoresSrt (${c.scoresSrt.length}), ` +
        `scoresBinary (${c.scoresBinary.length}), labels (${n}) must be equal length`,
    );
  }
}

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

/** `b` in the result is the count actually used, after the size cap and after dropping single-class draws. */
export function deltaAucClusterBootstrap(
  clusters: ClusterForwardPreds[],
  opts: { b?: number; rng: () => number },
): DeltaAucCi {
  for (let i = 0; i < clusters.length; i++) {
    assertClusterAligned(clusters[i], i);
  }

  const rng = opts.rng;
  const k = clusters.length;

  const pooledSrt = poolScores(clusters, 'srt');
  const pooledBinary = poolScores(clusters, 'binary');
  const aucSrtRes = forwardAuc(pooledSrt.scores, pooledSrt.labels);
  const aucBinaryRes = forwardAuc(pooledBinary.scores, pooledBinary.labels);
  const aucSrt = aucSrtRes.auc;
  const aucBinary = aucBinaryRes.auc;
  const pointDelta = aucSrt !== null && aucBinary !== null ? aucSrt - aucBinary : Number.NaN;

  const pooledN = pooledSrt.scores.length;
  const bTarget = resolveBootstrapB(pooledN, opts.b ?? 2000);

  const deltas: number[] = [];
  let degenerate = 0;
  let attempted = 0;

  if (k > 0) {
    for (let rep = 0; rep < bTarget; rep++) {
      attempted++;
      const drawn: number[] = new Array(k);
      for (let i = 0; i < k; i++) {
        // rng() === 1 would index clusters[k]. The contract is [0, 1).
        drawn[i] = Math.min(k - 1, Math.max(0, Math.floor(rng() * k)));
      }

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
        // Count it. Redrawing to fill B would bias the CI toward balanced samples.
        degenerate++;
        continue;
      }
      deltas.push(aSrt.auc - aBin.auc);
    }
  }

  const usableB = deltas.length;
  const degenerateFraction = attempted > 0 ? degenerate / attempted : 0;

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

/** Linear interpolation on rank p*(n−1), not nearest rank. */
function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sortedAsc[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}
