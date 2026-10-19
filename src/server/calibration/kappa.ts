// Cohen's κ = (p_o − p_e) / (1 − p_e). Cohen, Educ Psychol Meas 1960.
// Categories are the union of labels seen on either rater. p_e = 1 is 0/0, so κ is null.

export interface KappaResult {
  /** Null when κ is 0/0. A length mismatch throws instead of becoming a reason. */
  kappa: number | null;
  po: number;
  pe: number;
  n: number;
  reason?: 'no-variance' | 'empty';
}
export function cohenKappa(rater1: (string | number)[], rater2: (string | number)[]): KappaResult {
  if (rater1.length !== rater2.length) {
    throw new Error('cohenKappa: rater1 and rater2 must have equal length');
  }
  const n = rater1.length;
  if (n === 0) return { kappa: null, po: 0, pe: 0, n: 0, reason: 'empty' };

  const categories = new Set<string | number>();
  for (let i = 0; i < n; i++) {
    categories.add(rater1[i]);
    categories.add(rater2[i]);
  }
  const cats = Array.from(categories);
  const idx = new Map(cats.map((c, i) => [c, i]));
  const C = cats.length;

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
