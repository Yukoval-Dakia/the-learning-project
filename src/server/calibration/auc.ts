// ROC-AUC via Mann-Whitney. Ties count 0.5. Hanley & McNeil, Radiology 1982.
// The O(n²) sum is the form a wrong value can be audited against. A wrong AUC flips
// the V-A1-fwd verdict. A rank form stays out until the bootstrap N>5000 cap trips.
// Scores must already be pre-attempt predictions. This function only ranks.

export interface AucResult {
  /** Null when one class is absent. 0.5 would invent a neutral AUC. */
  auc: number | null;
  n: number;
  n1: number;
  n0: number;
  reason?: 'no-positives' | 'no-negatives' | 'empty';
}

/** A single class has no ROC-AUC. Returning 0.5 would invent a neutral signal. */
export function forwardAuc(scores: number[], labels: (0 | 1)[]): AucResult {
  if (scores.length !== labels.length) {
    throw new Error('forwardAuc: scores and labels must have equal length');
  }
  const n = scores.length;
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < n; i++) {
    // The (0|1) type is unchecked at runtime. Any other value throws instead of counting as a negative.
    const y = labels[i];
    if (y !== 0 && y !== 1) {
      throw new Error(`forwardAuc: label at index ${i} must be 0 or 1 (got ${y})`);
    }
    if (y === 1) pos.push(scores[i]);
    else neg.push(scores[i]);
  }
  const n1 = pos.length;
  const n0 = neg.length;

  if (n1 === 0 && n0 === 0) return { auc: null, n: 0, n1: 0, n0: 0, reason: 'empty' };
  if (n1 === 0) return { auc: null, n, n1, n0, reason: 'no-positives' };
  if (n0 === 0) return { auc: null, n, n1, n0, reason: 'no-negatives' };

  let u = 0;
  for (let i = 0; i < n1; i++) {
    const p = pos[i];
    for (let j = 0; j < n0; j++) {
      const q = neg[j];
      if (p > q) u += 1;
      else if (p === q) u += 0.5;
    }
  }
  return { auc: u / (n1 * n0), n, n1, n0 };
}
