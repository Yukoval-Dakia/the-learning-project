// forward-AUC: ROC-AUC for binary outcomes via the Mann–Whitney U identity
//   AUC = P(score_pos > score_neg) = (Σ_{i∈P} Σ_{j∈N} S(p_i, q_j)) / (n1 · n0)
//   where S(a,b) = 1 if a>b, 0.5 if a==b (tie), 0 if a<b.
// Source: Hanley & McNeil, "The meaning and use of the area under a ROC curve",
//   Radiology 1982.
//
// The O(n²) double-sum is the auditable reference form at harness scale (a wrong AUC
// silently flips the V-A1-fwd verdict). A rank-form O(n log n) variant is NOT built
// (YAGNI) unless the bootstrap's N>5000 guard actually trips.
//
// PURE — no IO, no DB.
//
// FORWARD CONTRACT: the caller passes `scores` = predicted P from the PRE-attempt θ̂
//   (θ̂_{t−1}) and `labels` = the realized outcome_t. This function performs NO fitting
//   and never sees θ̂; it only ranks. The no-leakage guarantee lives in the replay
//   engine that produces the scores, not here.

export interface AucResult {
  /** AUC in [0,1], or null when one class is absent (do NOT silently return 0.5). */
  auc: number | null;
  /** total number of (score,label) pairs. */
  n: number;
  /** number of positive-label observations. */
  n1: number;
  /** number of negative-label observations. */
  n0: number;
  reason?: 'no-positives' | 'no-negatives' | 'empty';
}

/**
 * Mann–Whitney-U forward-AUC over (score, binary label) pairs.
 *
 * Degenerate cases return `auc:null` with a reason (a single-class sample has NO
 * defined ROC-AUC — collapsing it to 0.5 would fabricate a neutral signal):
 *   - n1==0 && n0==0 → 'empty'
 *   - n1==0          → 'no-positives'
 *   - n0==0          → 'no-negatives'
 * Length mismatch → throws.
 */
export function forwardAuc(scores: number[], labels: (0 | 1)[]): AucResult {
  if (scores.length !== labels.length) {
    throw new Error('forwardAuc: scores and labels must have equal length');
  }
  const n = scores.length;
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < n; i++) {
    // OCR finding 4: `labels` is typed (0|1)[] but runtime-unchecked — any value other
    // than 1 (e.g. 2 or -1 from corrupt upstream data) silently falls into the negative
    // branch, corrupting n0/n1 and the AUC without any signal. Reject non-binary labels.
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
      // p < q → +0
    }
  }
  return { auc: u / (n1 * n0), n, n1, n0 };
}
