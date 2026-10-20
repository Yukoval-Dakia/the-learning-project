// ICC(1,1) one-way ANOVA. Shrout & Fleiss, Psych Bull 1979.
// deff = 1 + (m−1)·ICC, effectiveN = N/deff. Kish, Survey Sampling 1965.
// A wrong deff inflates N and can turn INSUFFICIENT into a false PASS.
// The gate reports this as a floor. The decision is the cluster bootstrap, which keeps
// within-KC correlation. This ICC is over binary labels, not residual autocorrelation.

export interface IccResult {
  /** Clamped to [0, 1]. Null when the ANOVA term is undefined. */
  icc: number | null;
  reason?: 'all-singleton' | 'single-cluster' | 'zero-variance' | 'empty';
  k: number;
  n: number;
  /** (N − Σ n_i²/N) / (k−1). 0 when that denominator is 0. */
  m0: number;
}

export interface EffectiveNResult {
  /** N when ICC is undefined. Never NaN. */
  effectiveN: number;
  /** 1 when ICC is undefined. There is no correlation to deflate by. */
  deff: number;
}

/** Empty clusters are dropped before k is counted. See the filter below. */
export function iccOneWayAnova(clusters: (0 | 1)[][]): IccResult {
  // An empty cluster adds nothing to the sums but would inflate k, so N−k can go negative
  // and MSW silently flips sign.
  const nonEmpty = clusters.filter((c) => c.length > 0);
  const k = nonEmpty.length;
  if (k === 0) return { icc: null, reason: 'empty', k: 0, n: 0, m0: 0 };

  const sizes = nonEmpty.map((c) => c.length);
  const n = sizes.reduce((a, b) => a + b, 0);
  if (n === 0) return { icc: null, reason: 'empty', k, n: 0, m0: 0 };
  // Between-variance divides by k−1.
  if (k === 1) return { icc: null, reason: 'single-cluster', k, n, m0: 0 };
  // Every retained cluster has size 1, so the within sum of squares has no denominator.
  if (n - k === 0) return { icc: null, reason: 'all-singleton', k, n, m0: 0 };

  let grandSum = 0;
  for (const c of nonEmpty) for (const y of c) grandSum += y;
  const grandMean = grandSum / n;

  let totalVar = 0;
  for (const c of nonEmpty) for (const y of c) totalVar += (y - grandMean) * (y - grandMean);
  // Identical labels have a defined ICC of 0. The cases above are undefined estimators.
  if (totalVar === 0) {
    const m0z = (n - sizes.reduce((a, s) => a + s * s, 0) / n) / (k - 1);
    return { icc: 0, reason: 'zero-variance', k, n, m0: m0z };
  }

  const clusterMeans = nonEmpty.map((c) => c.reduce<number>((a, b) => a + b, 0) / c.length);

  let ssBetween = 0;
  for (let i = 0; i < k; i++) {
    const diff = clusterMeans[i] - grandMean;
    ssBetween += sizes[i] * diff * diff;
  }
  const msb = ssBetween / (k - 1);

  let ssWithin = 0;
  for (let i = 0; i < k; i++) {
    for (const y of nonEmpty[i]) {
      const diff = y - clusterMeans[i];
      ssWithin += diff * diff;
    }
  }
  const msw = ssWithin / (n - k);

  const sumSq = sizes.reduce((a, s) => a + s * s, 0);
  const m0 = (n - sumSq / n) / (k - 1);

  const denom = msb + (m0 - 1) * msw;
  let icc = denom === 0 ? 0 : (msb - msw) / denom;
  // A negative estimate is a sampling artifact. The parameter is non-negative.
  if (icc < 0) icc = 0;
  if (icc > 1) icc = 1;

  return { icc, k, n, m0 };
}

/** Kish: 1 + (m−1)·ICC. */
export function designEffect(m: number, icc: number): number {
  return 1 + (m - 1) * icc;
}

/** Undefined ICC forces deff to 1 and effectiveN to N. Multiplying by null would yield NaN. */
export function effectiveNFromClusters(clusters: (0 | 1)[][]): EffectiveNResult & IccResult {
  const icc = iccOneWayAnova(clusters);
  if (icc.icc === null) {
    // No estimable correlation, so do not deflate. Empty stays 0.
    return { ...icc, deff: 1, effectiveN: icc.n };
  }
  const deff = designEffect(icc.m0, icc.icc);
  const effectiveN = deff > 0 ? icc.n / deff : icc.n;
  return { ...icc, deff, effectiveN };
}
