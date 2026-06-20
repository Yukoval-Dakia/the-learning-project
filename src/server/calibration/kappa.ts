// Cohen's κ — chance-corrected agreement between two raters on a binary/categorical
// label. Built for the future A9 gate (LLM-judge vs human-rater agreement).
//   p_o = observed agreement = Σ_i n_ii / N
//   p_e = chance agreement   = Σ_i (rowSum_i/N)(colSum_i/N)
//   κ   = (p_o − p_e) / (1 − p_e)
// Source: Cohen, "A coefficient of agreement for nominal scales", Educ Psychol Meas 1960.
//
// PURE — no IO, no DB. Categories are the union of the labels observed across both raters.

export interface KappaResult {
  /** κ in (−∞, 1], or null when undefined (see reason). */
  kappa: number | null;
  /** observed agreement. */
  po: number;
  /** expected (chance) agreement. */
  pe: number;
  /** number of paired ratings. */
  n: number;
  reason?: 'no-variance' | 'empty';
}

/**
 * Cohen's κ over two equal-length rater arrays (binary or categorical labels).
 *
 * Edge cases:
 *   - N==0 → {kappa:null, reason:'empty'}.
 *   - p_e==1 (both raters always use the same single category → chance agreement is
 *     certain) → {kappa:null, reason:'no-variance'} (κ is 0/0, undefined).
 *   - length mismatch → throws (consistent with ece/auc; 'length-mismatch' is NOT a
 *     KappaResult.reason — it is a programming error, not a degenerate-data signal).
 */
export function cohenKappa(rater1: (string | number)[], rater2: (string | number)[]): KappaResult {
  if (rater1.length !== rater2.length) {
    throw new Error('cohenKappa: rater1 and rater2 must have equal length');
  }
  const n = rater1.length;
  if (n === 0) return { kappa: null, po: 0, pe: 0, n: 0, reason: 'empty' };

  // Union of categories.
  const categories = new Set<string | number>();
  for (let i = 0; i < n; i++) {
    categories.add(rater1[i]);
    categories.add(rater2[i]);
  }
  const cats = Array.from(categories);
  const idx = new Map(cats.map((c, i) => [c, i]));
  const C = cats.length;

  // Confusion counts + marginals.
  const rowSum = new Array<number>(C).fill(0);
  const colSum = new Array<number>(C).fill(0);
  let agree = 0;
  for (let i = 0; i < n; i++) {
    const r = idx.get(rater1[i]) as number;
    const c = idx.get(rater2[i]) as number;
    rowSum[r] += 1;
    colSum[c] += 1;
    if (r === c) agree += 1;
  }

  const po = agree / n;
  let pe = 0;
  for (let i = 0; i < C; i++) {
    pe += (rowSum[i] / n) * (colSum[i] / n);
  }

  if (pe === 1) return { kappa: null, po, pe, n, reason: 'no-variance' };

  const kappa = (po - pe) / (1 - pe);
  return { kappa, po, pe, n };
}
