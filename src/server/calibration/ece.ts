// ECE = Σ_b (n_b / N) · |acc_b − conf_b|. Naeini et al., AAAI 2015; Guo et al., ICML 2017.
// A wrong value yields a false calibration verdict, so this is the textbook sum, not a variant.

export type Binning = 'equal-width' | 'equal-count';

export interface ReliabilityBin {
  /** Equal-count edges are the realized group min and max. Display only. ECE ignores them. */
  binLo: number;
  binHi: number;
  n: number;
  conf: number;
  acc: number;
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

/** An empty sample returns ECE 0 and does not throw. The caller decides if that is an error. */
export function ece(predictions: number[], labels: (0 | 1)[], opts: EceOptions = {}): EceResult {
  if (predictions.length !== labels.length) {
    throw new Error('ece: predictions and labels must have equal length');
  }
  const binning: Binning = opts.binning ?? 'equal-count';
  const k = opts.k ?? 10;
  // k < 1 would skip the loop and report ECE 0, a silent "perfectly calibrated" verdict.
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`ece: k must be an integer >= 1 (got ${k})`);
  }
  const n = predictions.length;

  // A non-finite prediction becomes a NaN bin index, or silently mis-sorts equal-count bins.
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(predictions[i])) {
      throw new Error(`ece: prediction at index ${i} is not finite (got ${predictions[i]})`);
    }
  }

  if (n === 0) {
    return { ece: 0, n: 0, bins: [], binning, k };
  }

  let binIndices: number[][];
  let displayEdges: Array<{ lo: number; hi: number }>;

  if (binning === 'equal-width') {
    binIndices = Array.from({ length: k }, () => [] as number[]);
    for (let i = 0; i < n; i++) {
      const p = predictions[i];
      // p = 1 lands in the last closed bin. p < 0 is not a probability and would index below 0.
      const idx = Math.min(k - 1, Math.floor(p * k));
      binIndices[Math.max(0, idx)].push(i);
    }
    displayEdges = Array.from({ length: k }, (_, b) => ({ lo: b / k, hi: (b + 1) / k }));
  } else {
    // Quantile groups. Ties may make them unequal. ECE uses membership, not equal counts.
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => predictions[a] - predictions[b],
    );
    binIndices = Array.from({ length: k }, () => [] as number[]);
    for (let pos = 0; pos < n; pos++) {
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
