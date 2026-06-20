// Expected Calibration Error (ECE) + per-bin reliability table.
//
// Source: binned reliability diagram (Naeini, Cooper & Hauskrecht, AAAI 2015;
//   Guo, Pleiss, Sun & Weinberger, ICML 2017 "On Calibration of Modern Neural
//   Networks"). Bin the predicted P into K bins, then:
//     ECE = Σ_b (n_b / N) · |acc_b − conf_b|
//   where conf_b = mean predicted P in bin b, acc_b = empirical accuracy in bin b.
//
// PURE — no IO, no DB. The harness scores forward predictions with this; a wrong
// ECE silently yields a false calibration verdict, so the formula matches the
// textbook definition exactly and is pinned by hand-computed known-answer tests.

export type Binning = 'equal-width' | 'equal-count';

export interface ReliabilityBin {
  /** displayed bin lower edge (equal-width: k/K; equal-count: realized group min — cosmetic). */
  binLo: number;
  /** displayed bin upper edge (equal-width: (k+1)/K; equal-count: realized group max — cosmetic). */
  binHi: number;
  /** number of predictions in the bin. */
  n: number;
  /** mean predicted P in the bin (confidence). 0 for an empty bin. */
  conf: number;
  /** empirical accuracy (mean label) in the bin. 0 for an empty bin. */
  acc: number;
  /** |acc − conf|. 0 for an empty bin. */
  gap: number;
}

export interface EceResult {
  ece: number;
  n: number;
  bins: ReliabilityBin[];
  binning: Binning;
  k: number;
}

export interface EceOptions {
  binning?: Binning;
  k?: number;
}

/**
 * Expected Calibration Error over (predicted P, binary label) pairs.
 *
 * @param predictions predicted probabilities in [0,1].
 * @param labels      binary outcomes (0|1), same length as predictions.
 * @param opts.binning 'equal-count' (default — quantile groups) or 'equal-width' (1/K bins).
 * @param opts.k       number of bins (default 10).
 *
 * Edge cases:
 *   - N=0 → {ece:0, n:0, bins:[]} (does NOT throw — the caller decides whether an
 *     empty sample is an error).
 *   - empty bins contribute 0 weight (conf=acc=gap=0).
 *   - length mismatch → throws.
 *
 * NOTE (m1): equal-count bin edges are the REALIZED group min/max (quantiles), not
 *   evenly-spaced partitions — purely cosmetic for the reliability display. ECE is
 *   edge-independent (it only depends on which points share a bin), so this does not
 *   affect the ECE value.
 */
export function ece(predictions: number[], labels: (0 | 1)[], opts: EceOptions = {}): EceResult {
  if (predictions.length !== labels.length) {
    throw new Error('ece: predictions and labels must have equal length');
  }
  const binning: Binning = opts.binning ?? 'equal-count';
  const k = opts.k ?? 10;
  const n = predictions.length;

  if (n === 0) {
    return { ece: 0, n: 0, bins: [], binning, k };
  }

  // Build per-bin index lists.
  let binIndices: number[][];
  let displayEdges: Array<{ lo: number; hi: number }>;

  if (binning === 'equal-width') {
    binIndices = Array.from({ length: k }, () => [] as number[]);
    for (let i = 0; i < n; i++) {
      const p = predictions[i];
      // min(K-1, floor(p*K)) lands p=1.0 in the last, closed bin [(K-1)/K, 1.0].
      const idx = Math.min(k - 1, Math.floor(p * k));
      // Guard p<0 (shouldn't happen for a probability) → bin 0.
      binIndices[Math.max(0, idx)].push(i);
    }
    displayEdges = Array.from({ length: k }, (_, b) => ({ lo: b / k, hi: (b + 1) / k }));
  } else {
    // equal-count: sort by predicted P, split into K contiguous index-quantile groups.
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => predictions[a] - predictions[b],
    );
    binIndices = Array.from({ length: k }, () => [] as number[]);
    for (let pos = 0; pos < n; pos++) {
      // floor(pos * K / N) gives ~N/K per group; ties may make groups unequal — OK.
      const b = Math.min(k - 1, Math.floor((pos * k) / n));
      binIndices[b].push(order[pos]);
    }
    displayEdges = binIndices.map((idxs) => {
      if (idxs.length === 0) return { lo: 0, hi: 0 };
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const i of idxs) {
        if (predictions[i] < lo) lo = predictions[i];
        if (predictions[i] > hi) hi = predictions[i];
      }
      return { lo, hi };
    });
  }

  const bins: ReliabilityBin[] = [];
  let eceSum = 0;
  for (let b = 0; b < binIndices.length; b++) {
    const idxs = binIndices[b];
    const nb = idxs.length;
    if (nb === 0) {
      bins.push({
        binLo: displayEdges[b].lo,
        binHi: displayEdges[b].hi,
        n: 0,
        conf: 0,
        acc: 0,
        gap: 0,
      });
      continue;
    }
    let sumP = 0;
    let sumY = 0;
    for (const i of idxs) {
      sumP += predictions[i];
      sumY += labels[i];
    }
    const conf = sumP / nb;
    const acc = sumY / nb;
    const gap = Math.abs(acc - conf);
    eceSum += (nb / n) * gap;
    bins.push({ binLo: displayEdges[b].lo, binHi: displayEdges[b].hi, n: nb, conf, acc, gap });
  }

  return { ece: eceSum, n, bins, binning, k };
}
