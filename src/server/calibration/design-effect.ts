// design-effect / ICC / effective-N — the dossier's cross-cutting evidence-inflation
// fix (A8/A9/A12/B1 all rely on it). Clustered binary observations (e.g. all forward
// predictions for one KC form one cluster) carry less independent information than
// their raw count N; the design effect deflates N to an effective sample size.
//
// Sources:
//   - ICC(1,1) one-way random-effects ANOVA estimator: Shrout & Fleiss,
//     "Intraclass correlations: uses in assessing rater reliability", Psych Bull 1979.
//   - design effect deff = 1 + (m−1)·ICC, effectiveN = N/deff: Kish, Survey Sampling 1965.
//
// PURE — no IO, no DB. A wrong deff silently inflates the evidence base and can flip an
// INSUFFICIENT verdict to a (false) PASS, so the estimator matches the textbook ANOVA
// definition exactly and is pinned by hand-computed known-answer tests.
//
// SCOPE NOTE (B4): in the V-A1-fwd gate this effectiveN is a REPORTED COARSE FLOOR /
//   diagnostic only — the decision is the paired cluster bootstrap CI (which preserves
//   within-KC serial correlation by resampling whole clusters). This is ICC over the
//   per-KC binary LABELS, not a residual-autocorrelation measure; that distinction is
//   surfaced in the report, not hidden.

export interface IccResult {
  /** ICC(1,1) in [0,1] (clamped), or null when undefined (see reason). */
  icc: number | null;
  reason?: 'all-singleton' | 'single-cluster' | 'zero-variance' | 'empty';
  /** number of clusters. */
  k: number;
  /** total observations Σ n_i. */
  n: number;
  /** the ANOVA average cluster size m0 = (N − Σ n_i²/N)/(k−1); 0 when undefined. */
  m0: number;
}

export interface EffectiveNResult {
  /** N / deff (never NaN — forced to N when ICC is undefined). */
  effectiveN: number;
  /** 1 + (m0−1)·ICC (forced to 1 when ICC is undefined). */
  deff: number;
}

/**
 * ICC(1,1) via the one-way random-effects ANOVA estimator over clustered binary
 * observations.
 *
 *   k clusters, sizes n_i, N = Σ n_i, grand mean ȳ, cluster means ȳ_i.
 *   MSB = Σ_i n_i (ȳ_i − ȳ)² / (k−1)
 *   MSW = Σ_i Σ_j (y_ij − ȳ_i)² / (N − k)
 *   m0  = (N − Σ_i n_i² / N) / (k−1)
 *   ICC = (MSB − MSW) / (MSB + (m0−1)·MSW), clamped to [0,1].
 *
 * Edge cases each return a flagged null/0:
 *   - empty (k==0) → null 'empty'
 *   - single cluster (k==1) → null 'single-cluster' (MSB undefined, k−1=0)
 *   - all clusters size 1 (N−k==0) → null 'all-singleton' (MSW undefined)
 *   - zero total variance (every y identical) → 0 'zero-variance'
 */
export function iccOneWayAnova(clusters: (0 | 1)[][]): IccResult {
  // OCR finding 5: drop EMPTY clusters before counting. An empty sub-array contributes 0
  // observations but still inflates the raw cluster count k, so a mix like [[1,0],[],[]]
  // would pass the (n−k>0) guard with the raw k=3 while N=2, making MSW = ssWithin/(N−k)
  // = ssWithin/(−1) → a NEGATIVE denominator → a silently wrong ICC. An empty cluster
  // carries no within- or between-variance, so dropping it is the documented, math-safe
  // choice (it cannot change MSB/MSW/m0 except via the spurious k inflation we remove).
  const nonEmpty = clusters.filter((c) => c.length > 0);
  const k = nonEmpty.length;
  if (k === 0) return { icc: null, reason: 'empty', k: 0, n: 0, m0: 0 };

  const sizes = nonEmpty.map((c) => c.length);
  const n = sizes.reduce((a, b) => a + b, 0);
  if (n === 0) return { icc: null, reason: 'empty', k, n: 0, m0: 0 };
  if (k === 1) return { icc: null, reason: 'single-cluster', k, n, m0: 0 };
  // After dropping empties, k == number of non-empty clusters and n == Σ non-empty sizes,
  // so n − k > 0 here iff at least one retained cluster has size ≥ 2 (the within-variance
  // requirement). all-singleton (every retained cluster size 1) → n − k == 0 → MSW undefined.
  if (n - k === 0) return { icc: null, reason: 'all-singleton', k, n, m0: 0 };

  // From here on operate on `nonEmpty` only — every retained cluster has length ≥ 1.
  let grandSum = 0;
  for (const c of nonEmpty) for (const y of c) grandSum += y;
  const grandMean = grandSum / n;

  // Zero total variance (every observation identical) → no signal to partition.
  let totalVar = 0;
  for (const c of nonEmpty) for (const y of c) totalVar += (y - grandMean) * (y - grandMean);
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
  // n − k > 0 here (guarded above after dropping empties), so MSW is finite and the
  // denominator is strictly positive — never a divide-by-negative.
  const msw = ssWithin / (n - k);

  const sumSq = sizes.reduce((a, s) => a + s * s, 0);
  const m0 = (n - sumSq / n) / (k - 1);

  const denom = msb + (m0 - 1) * msw;
  // denom can only be 0 if msb==0 and msw==0, i.e. zero variance — already handled above.
  let icc = denom === 0 ? 0 : (msb - msw) / denom;
  // Clamp to [0,1]: a negative ICC (msw>msb, more within- than between-variance) is a
  // sampling artefact for a non-negative true ICC; clamp to 0. Values >1 cannot occur.
  if (icc < 0) icc = 0;
  if (icc > 1) icc = 1;

  return { icc, k, n, m0 };
}

/** Kish design effect: deff = 1 + (m−1)·ICC. */
export function designEffect(m: number, icc: number): number {
  return 1 + (m - 1) * icc;
}

/**
 * effective-N from clustered binary observations: deff = 1 + (m0−1)·ICC,
 * effectiveN = N/deff. NEVER returns NaN (m4): when ICC is undefined (all-singleton /
 * single-cluster / empty), deff is forced to 1 and effectiveN to N (or 0 for empty),
 * i.e. the no-clustering identity — there is no estimable within-cluster correlation to
 * deflate by.
 */
export function effectiveNFromClusters(clusters: (0 | 1)[][]): EffectiveNResult & IccResult {
  const icc = iccOneWayAnova(clusters);
  if (icc.icc === null) {
    // Undefined ICC → no deflation. effectiveN = N (0 when empty). NEVER 1+(m0-1)*null.
    return { ...icc, deff: 1, effectiveN: icc.n };
  }
  const deff = designEffect(icc.m0, icc.icc);
  // deff >= 1 here (ICC in [0,1], m0 >= 1 for a real multi-cluster sample), so no div-by-0.
  const effectiveN = deff > 0 ? icc.n / deff : icc.n;
  return { ...icc, deff, effectiveN };
}
