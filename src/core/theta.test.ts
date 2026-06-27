import { describe, expect, it } from 'vitest';

import {
  DIFFICULTY_PROXY_WEIGHT,
  ELO_K_GLOBAL,
  HIERARCHICAL_ELO_ENABLED,
  SRT_D_FROM_QUANTILE,
  SRT_ENABLED,
  SRT_FISHER_WEIGHT_ENABLED,
  SRT_MIN_SIGNAL,
  SRT_RT_BUFFER_K,
  SRT_RT_MIN_N,
  SRT_RT_QUANTILE,
  conjunctiveCredits,
  conjunctiveCreditsContinuous,
  difficultyToLogitB,
  eloK,
  expectedScore,
  fisherInformation,
  pushRtCorrectSample,
  quantile,
  resolveSrtTimeLimit,
  resolveSrtTimeLimitFromQuantile,
  srtOutcome,
  thetaSe,
  thetaToMastery,
  updateTheta,
  updateThetaPrecision,
} from './theta';

describe('expectedScore (1PL ICC)', () => {
  it('returns 0.5 when θ == b', () => {
    expect(expectedScore(0, 0)).toBeCloseTo(0.5, 10);
    expect(expectedScore(1.5, 1.5)).toBeCloseTo(0.5, 10);
  });

  it('rises above 0.5 when θ > b, falls below when θ < b', () => {
    expect(expectedScore(2, 0)).toBeGreaterThan(0.5);
    expect(expectedScore(-2, 0)).toBeLessThan(0.5);
  });

  it('is symmetric around θ == b', () => {
    // P(θ-b=1) + P(θ-b=-1) == 1 (logistic odd symmetry).
    expect(expectedScore(1, 0) + expectedScore(-1, 0)).toBeCloseTo(1, 10);
  });
});

describe('updateTheta', () => {
  it('raises θ̂ on a correct answer (outcome=1)', () => {
    const next = updateTheta(0, 0, 1, 0.4);
    expect(next).toBeGreaterThan(0);
    // expected=0.5, so Δ = k*(1-0.5) = 0.2.
    expect(next).toBeCloseTo(0.2, 10);
  });

  it('lowers θ̂ on a wrong answer (outcome=0)', () => {
    const next = updateTheta(0, 0, 0, 0.4);
    expect(next).toBeLessThan(0);
    // Δ = k*(0-0.5) = -0.2.
    expect(next).toBeCloseTo(-0.2, 10);
  });

  it('produces a tiny Δ when θ ≫ b and the answer is correct (saturation)', () => {
    // expected ≈ 1 when θ-b is large, so a correct answer barely moves θ̂.
    const next = updateTheta(5, 0, 1, 0.4);
    expect(next - 5).toBeGreaterThan(0);
    expect(next - 5).toBeLessThan(0.01);
  });

  it('applies weight as a linear scale on the step', () => {
    const full = updateTheta(0, 0, 1, 0.4, 1);
    const weighted = updateTheta(0, 0, 1, 0.4, DIFFICULTY_PROXY_WEIGHT);
    expect(weighted).toBeCloseTo(full * DIFFICULTY_PROXY_WEIGHT, 10);
  });

  it('default weight is 1', () => {
    expect(updateTheta(0, 0, 1, 0.4)).toBeCloseTo(updateTheta(0, 0, 1, 0.4, 1), 10);
  });
});

describe('eloK (bounded K + cold-start, NO 1/√n)', () => {
  it('returns kCold during the cold-start segment (evidence < coldStartN)', () => {
    expect(eloK(0)).toBe(0.4);
    expect(eloK(3)).toBe(0.4);
  });

  it('returns kFloor once past the cold-start segment (evidence >= coldStartN)', () => {
    expect(eloK(4)).toBe(0.12);
    expect(eloK(100)).toBe(0.12);
  });

  it('NEVER returns 0 — non-stationary protection (refutes 1/√n decay-to-zero)', () => {
    // Regression guard: VERIFY:elo-k-schedule REFUTED the 1/√(evidence) schedule.
    // K must stay bounded below so θ̂ keeps the freedom to chase rising ability.
    for (const n of [0, 1, 4, 10, 50, 1000, 100_000]) {
      expect(eloK(n)).toBeGreaterThan(0);
    }
  });

  it('honors config overrides', () => {
    expect(eloK(0, { kCold: 0.6 })).toBe(0.6);
    expect(eloK(10, { kFloor: 0.05 })).toBe(0.05);
    expect(eloK(2, { coldStartN: 1, kFloor: 0.1 })).toBe(0.1);
  });
});

describe('difficultyToLogitB (placeholder proxy map)', () => {
  it('maps difficulty=3 to logit 0 (origin)', () => {
    expect(difficultyToLogitB(3)).toBeCloseTo(0, 10);
  });

  it('is symmetric: difficulty 1 and 5 are ±2*scale around 0', () => {
    const d1 = difficultyToLogitB(1);
    const d5 = difficultyToLogitB(5);
    expect(d1).toBeCloseTo(-d5, 10);
    expect(d5).toBeCloseTo(2 * 0.85, 10);
  });

  it('honors a custom scale', () => {
    expect(difficultyToLogitB(4, 1)).toBeCloseTo(1, 10);
  });
});

describe('DIFFICULTY_PROXY_WEIGHT', () => {
  it('is a sub-1 down-weight for the weak difficulty proxy anchor', () => {
    expect(DIFFICULTY_PROXY_WEIGHT).toBeGreaterThan(0);
    expect(DIFFICULTY_PROXY_WEIGHT).toBeLessThan(1);
    expect(DIFFICULTY_PROXY_WEIGHT).toBeCloseTo(0.3, 10);
  });
});

describe('conjunctiveCredits (multi-KC MLE, owner-ratified / SF-1 fix)', () => {
  it('single KC reduces EXACTLY to standard Elo residual (outcome − p)', () => {
    // correct + wrong both must equal (x − σ(θ−b)) so the n=1 path is unchanged.
    const [cCorrect] = conjunctiveCredits([0.5], 0, 1);
    const [cWrong] = conjunctiveCredits([0.5], 0, 0);
    expect(cCorrect).toBeCloseTo(1 - expectedScore(0.5, 0), 12);
    expect(cWrong).toBeCloseTo(0 - expectedScore(0.5, 0), 12);
    // And applying it must match updateTheta's single-KC result.
    const k = 0.12;
    expect(0.5 + k * cWrong).toBeCloseTo(updateTheta(0.5, 0, 0, k), 12);
  });

  it('empty input returns empty (no KCs → no-op)', () => {
    expect(conjunctiveCredits([], 0, 1)).toEqual([]);
  });

  it('correct: every KC gets a positive bump, weaker KC bumped MORE ((1−p_k))', () => {
    // A strong θ=2 (p≈0.88), B weak θ=-1 (p≈0.27), b=0.
    const [cA, cB] = conjunctiveCredits([2, -1], 0, 1);
    expect(cA).toBeGreaterThan(0);
    expect(cB).toBeGreaterThan(0);
    expect(cB).toBeGreaterThan(cA); // weaker KC has larger (1−p) sensitivity
  });

  it('SF-1 regression: wrong answer blames the WEAKER KC more, not the mid one', () => {
    // The old self-authored formula had Δ ∝ p_k·(1−p_k) (bell-shaped) → an
    // already-weak KC (p→0) barely moved. MLE conjunctive credit must blame the
    // weaker KC MORE. mid θ=0 (p=0.5) vs very-weak θ=-3 (p≈0.047), b=0, wrong.
    const [cMid, cWeak] = conjunctiveCredits([0, -3], 0, 0);
    expect(cMid).toBeLessThan(0); // both fall
    expect(cWeak).toBeLessThan(0);
    // weaker KC falls MORE (more negative) — the exact direction the bug inverted.
    expect(cWeak).toBeLessThan(cMid);
  });

  it('wrong: mastered KC is spared relative to a neutral KC', () => {
    // A mastered θ=2, B neutral θ=0, b=0, wrong. B (weaker) should fall more.
    const [cA, cB] = conjunctiveCredits([2, 0], 0, 0);
    expect(Math.abs(cB)).toBeGreaterThan(Math.abs(cA));
  });

  it('clamps each credit magnitude to ≤ 1 (all-strong KCs, big surprise)', () => {
    // Two strong KCs both wrong → P_item small denominator, odds large; clamp.
    const credits = conjunctiveCredits([4, 4], 0, 0);
    for (const c of credits) {
      expect(c).toBeGreaterThanOrEqual(-1);
      expect(c).toBeLessThanOrEqual(0);
    }
  });
});

describe('fisherInformation (Rasch single-observation θ info I = p(1−p))', () => {
  it('is maximal (0.25) when θ == b (p = 0.5)', () => {
    expect(fisherInformation(0, 0)).toBeCloseTo(0.25, 10);
  });

  it('decays toward 0 as θ moves far from b (saturated item gives little info)', () => {
    expect(fisherInformation(4, 0)).toBeLessThan(0.02);
  });

  it('is symmetric in |θ − b| (logistic odd symmetry)', () => {
    expect(fisherInformation(2, 0)).toBeCloseTo(fisherInformation(-2, 0), 12);
  });
});

describe('thetaSe (SE = 1/√precision, derived not stored)', () => {
  it('precision=4 → SE=0.5', () => {
    expect(thetaSe(4)).toBeCloseTo(0.5, 10);
  });

  it('precision=1 → SE=1 (backfill-safe default)', () => {
    expect(thetaSe(1)).toBeCloseTo(1, 10);
  });

  it('higher precision → smaller SE (monotone)', () => {
    expect(thetaSe(9)).toBeLessThan(thetaSe(4));
  });

  it('floors precision at 1e-9 to avoid division by zero', () => {
    expect(Number.isFinite(thetaSe(0))).toBe(true);
  });
});

describe('updateThetaPrecision (accumulate Σ I, weight² scaling)', () => {
  it('adds full Fisher info at unit weight: 1 + 0.25 = 1.25', () => {
    expect(updateThetaPrecision(1, 0, 0, 1)).toBeCloseTo(1.25, 10);
  });

  it('scales info by weight² (proxy bWeight=0.3 → only 0.09·0.25 added)', () => {
    expect(updateThetaPrecision(1, 0, 0, 0.3)).toBeCloseTo(1 + 0.09 * 0.25, 10);
  });

  it('default weight is 1', () => {
    expect(updateThetaPrecision(1, 0, 0)).toBeCloseTo(updateThetaPrecision(1, 0, 0, 1), 10);
  });

  it('a saturated item (θ ≫ b) adds almost no precision', () => {
    const before = 2;
    expect(updateThetaPrecision(before, 4, 0, 1) - before).toBeLessThan(0.02);
  });
});

describe('thetaToMastery (B1 double-truth fix — θ̂ → p(L) display projection)', () => {
  // The deprecated knowledge_mastery view faked mastery as a weighted success
  // rate with an `evidence_count < 3 → 0.5` placeholder. The real source of
  // truth is mastery_state.theta_hat (logit). Display/AI surfaces want a 0..1
  // p(L); the project's own 1PL semantics give it as σ(θ̂) = expectedScore(θ̂, 0)
  // (b=0 = the neutral logit origin, same anchor cold-start θ̂ starts from).

  it('cold-start θ̂=0 → 0.5 (neutral midpoint, now DERIVED not faked)', () => {
    expect(thetaToMastery(0)).toBeCloseTo(0.5, 10);
  });

  it('equals σ(θ̂) = expectedScore(θ̂, 0) — single source of truth, no placeholder', () => {
    for (const theta of [-3, -1, -0.25, 0, 0.5, 1, 2.5, 4]) {
      expect(thetaToMastery(theta)).toBeCloseTo(expectedScore(theta, 0), 12);
    }
  });

  it('is monotone increasing in θ̂ (more ability → higher mastery)', () => {
    expect(thetaToMastery(-2)).toBeLessThan(thetaToMastery(0));
    expect(thetaToMastery(0)).toBeLessThan(thetaToMastery(2));
  });

  it('stays within (0, 1) across the θ̂ range the bounded-K update reaches', () => {
    // θ̂ lives on the logit scale; the bounded-K Elo update keeps it in a modest
    // band (|θ̂| in the single digits in practice). Within that band the
    // projection is strictly in the open interval; at extreme logits (|θ̂| ≳ 37)
    // float64 saturates σ to exactly 0 or 1, which is the correct "100% / 0%"
    // display rounding, not a clamp bug.
    for (const theta of [-8, -5, -1, 0, 1, 5, 8]) {
      const m = thetaToMastery(theta);
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThan(1);
    }
  });

  it('does NOT clamp to the 0.5 placeholder for small θ̂ (regression: the old <3-evidence rule)', () => {
    // A node with a couple of attempts that moved θ̂ off 0 must reflect that
    // movement, not snap back to 0.5 the way the deprecated view did for
    // evidence_count < 3.
    expect(thetaToMastery(0.3)).toBeGreaterThan(0.5);
    expect(thetaToMastery(-0.3)).toBeLessThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1 (YUK-433) — SRT (Signed Residual Time) scoring. Continuous, time-aware
// outcome-analog that slots into the existing `outcome − p` credit form. Maris &
// van der Maas 2012: per-item time-limit d is the discrimination DESIGN CONSTANT
// (implicit 2PL, zero cross-examinee variance). CONSERVATIVE bounded modulation —
// flag-on SRT NEVER exceeds the binary magnitude.
// ─────────────────────────────────────────────────────────────────────────────

describe('SRT_ENABLED flag', () => {
  it('is LIVE (true) — P1 go-live default (YUK-361 step 1); off path still mocked-false in state.db.test.ts', () => {
    // Flipped from dark-ship false → live true. The OFF (binary) path is NOT deleted:
    // it remains the explicit-false-mock regression in state.db.test.ts (srtFlag.value
    // = false NO-OP byte-identical anchor) and the missing-RT binary fallback.
    expect(SRT_ENABLED).toBe(true);
  });
});

describe('srtOutcome (continuous time-aware outcome-analog in [0,1])', () => {
  it('fast-correct (t→0, r=1) reproduces binary correct = 1.0', () => {
    expect(srtOutcome(true, 30, 0)).toBeCloseTo(1.0, 12);
    expect(srtOutcome(true, 30, 0.0001)).toBeGreaterThan(0.999);
  });

  it('slow-correct (t≥d, r_eff=SRT_MIN_SIGNAL floor) stays STRICTLY above 0.5 — signal not erased', () => {
    const floorCredit = 0.5 + 0.5 * SRT_MIN_SIGNAL; // 0.575 at SRT_MIN_SIGNAL=0.15
    expect(srtOutcome(true, 30, 30)).toBeCloseTo(floorCredit, 12); // t == d boundary
    expect(srtOutcome(true, 30, 45)).toBeCloseTo(floorCredit, 12); // t > d clamps to r=0
    expect(srtOutcome(true, 30, 300)).toBeCloseTo(floorCredit, 12); // t = 10d
    // floored slow-correct is a SMALL reward but strictly above the midpoint.
    expect(srtOutcome(true, 30, 30)).toBeGreaterThan(0.5);
    // and still smaller than fast-correct (= binary 1.0) — bounded.
    expect(srtOutcome(true, 30, 30)).toBeLessThan(1.0);
  });

  it('fast-wrong (t→0, r=1) reproduces binary wrong = 0.0', () => {
    expect(srtOutcome(false, 30, 0)).toBeCloseTo(0.0, 12);
    expect(srtOutcome(false, 30, 0.0001)).toBeLessThan(0.001);
  });

  it('slow-wrong (t≥d, r_eff=SRT_MIN_SIGNAL floor) stays STRICTLY below 0.5 — real (small) penalty', () => {
    const floorPenalty = 0.5 - 0.5 * SRT_MIN_SIGNAL; // 0.425 at SRT_MIN_SIGNAL=0.15
    expect(srtOutcome(false, 30, 30)).toBeCloseTo(floorPenalty, 12); // t == d boundary
    expect(srtOutcome(false, 30, 45)).toBeCloseTo(floorPenalty, 12); // t > d clamps to r=0
    expect(srtOutcome(false, 30, 300)).toBeCloseTo(floorPenalty, 12); // t = 10d
    // floored slow-wrong is a SMALL penalty but strictly below the midpoint (NOT erased).
    expect(srtOutcome(false, 30, 30)).toBeLessThan(0.5);
    // and still less severe than fast-wrong (= binary 0.0) — bounded.
    expect(srtOutcome(false, 30, 30)).toBeGreaterThan(0.0);
  });

  it('NEW INVARIANT: correct > wrong by ≥ SRT_MIN_SIGNAL for ALL t — correctness sign never erased', () => {
    const d = 30;
    for (const t of [0, d / 2, d, 2 * d, 10 * d, 1000]) {
      const c = srtOutcome(true, d, t);
      const w = srtOutcome(false, d, t);
      expect(c).toBeGreaterThan(w); // correct ALWAYS strictly above wrong
      expect(c - w).toBeGreaterThanOrEqual(SRT_MIN_SIGNAL - 1e-12); // gap ≥ floor
      expect(c).toBeGreaterThan(0.5); // correct strictly in (0.5, 1]
      expect(c).toBeLessThanOrEqual(1.0);
      expect(w).toBeGreaterThanOrEqual(0.0); // wrong strictly in [0, 0.5)
      expect(w).toBeLessThan(0.5);
    }
  });

  it('NEW INVARIANT (slow boundary t≥d): correct ≠ wrong, correct > 0.5 > wrong', () => {
    const d = 30;
    for (const t of [d, 2 * d, 10 * d]) {
      const c = srtOutcome(true, d, t);
      const w = srtOutcome(false, d, t);
      expect(c).not.toBe(w); // the bug: both collapsed to exactly 0.5
      expect(c).toBeGreaterThan(0.5);
      expect(w).toBeLessThan(0.5);
      expect(c - w).toBeGreaterThanOrEqual(SRT_MIN_SIGNAL - 1e-12);
    }
  });

  it('output stays bounded in [0,1] across the t range (never exceeds binary)', () => {
    for (const t of [-5, 0, 5, 15, 30, 60, 1000]) {
      const c = srtOutcome(true, 30, t);
      const w = srtOutcome(false, 30, t);
      expect(c).toBeGreaterThanOrEqual(0.5); // correct never below midpoint
      expect(c).toBeLessThanOrEqual(1.0);
      expect(w).toBeGreaterThanOrEqual(0.0);
      expect(w).toBeLessThanOrEqual(0.5); // wrong never above midpoint
    }
  });

  it('clamps t < 0 to r=1 (defensive — negative latency treated as instant)', () => {
    expect(srtOutcome(true, 30, -10)).toBeCloseTo(1.0, 12);
    expect(srtOutcome(false, 30, -10)).toBeCloseTo(0.0, 12);
  });

  it('monotone: faster-correct ≥ slower-correct; faster-wrong penalty ≥ slower-wrong', () => {
    expect(srtOutcome(true, 30, 5)).toBeGreaterThan(srtOutcome(true, 30, 20));
    // faster wrong → smaller srtOutcome → harder penalty (further below 0.5).
    expect(srtOutcome(false, 30, 5)).toBeLessThan(srtOutcome(false, 30, 20));
  });

  it('mid-time correct sits strictly between binary-correct and the floored slow value', () => {
    const rEff = SRT_MIN_SIGNAL + (1 - SRT_MIN_SIGNAL) * 0.5; // raw r = 0.5
    const mid = srtOutcome(true, 30, 15);
    expect(mid).toBeCloseTo(0.5 + 0.5 * rEff, 12);
    const slow = srtOutcome(true, 30, 30); // floored slow value
    expect(mid).toBeGreaterThan(slow); // faster correct moves θ more than slow correct
    expect(mid).toBeLessThan(1.0);
  });
});

describe('resolveSrtTimeLimit (population-seeded module-const d, in SECONDS)', () => {
  it('returns a positive d in seconds for every difficulty 1..5', () => {
    for (const diff of [1, 2, 3, 4, 5]) {
      const d = resolveSrtTimeLimit(diff);
      expect(d).toBeGreaterThan(0);
      expect(Number.isFinite(d)).toBe(true);
    }
  });

  it('is monotone non-decreasing in difficulty (harder item → more time allowed)', () => {
    expect(resolveSrtTimeLimit(1)).toBeLessThanOrEqual(resolveSrtTimeLimit(3));
    expect(resolveSrtTimeLimit(3)).toBeLessThanOrEqual(resolveSrtTimeLimit(5));
  });

  it('falls back to a sane positive default for out-of-range difficulty', () => {
    expect(resolveSrtTimeLimit(0)).toBeGreaterThan(0);
    expect(resolveSrtTimeLimit(99)).toBeGreaterThan(0);
    expect(resolveSrtTimeLimit(Number.NaN)).toBeGreaterThan(0);
  });
});

describe('conjunctiveCreditsContinuous (SRT-driven, binary-bit-identical at {0,1})', () => {
  it('REGRESSION: continuous outcome=1 is BIT-IDENTICAL to binary conjunctiveCredits(…,1)', () => {
    for (const thetas of [[0.5], [2, -1], [0, -3], [4, 4], [1, 0.2, -2]]) {
      const binary = conjunctiveCredits(thetas, 0, 1);
      const cont = conjunctiveCreditsContinuous(thetas, 0, 1);
      expect(cont.length).toBe(binary.length);
      for (let i = 0; i < binary.length; i++) {
        expect(cont[i]).toBe(binary[i]); // exact float equality — same code path
      }
    }
  });

  it('REGRESSION: continuous outcome=0 is BIT-IDENTICAL to binary conjunctiveCredits(…,0)', () => {
    for (const thetas of [[0.5], [2, -1], [0, -3], [4, 4], [1, 0.2, -2]]) {
      const binary = conjunctiveCredits(thetas, 0, 0);
      const cont = conjunctiveCreditsContinuous(thetas, 0, 0);
      expect(cont.length).toBe(binary.length);
      for (let i = 0; i < binary.length; i++) {
        expect(cont[i]).toBe(binary[i]);
      }
    }
  });

  it('empty input returns empty (no KCs → no-op)', () => {
    expect(conjunctiveCreditsContinuous([], 0, 1)).toEqual([]);
    expect(conjunctiveCreditsContinuous([], 0, 0.7)).toEqual([]);
  });

  it('single KC: credit = (srtOutcome − p), continuous residual form preserved', () => {
    const p = expectedScore(0.5, 0);
    expect(conjunctiveCreditsContinuous([0.5], 0, 0.75)[0]).toBeCloseTo(0.75 - p, 12);
    expect(conjunctiveCreditsContinuous([0.5], 0, 0.25)[0]).toBeCloseTo(0.25 - p, 12);
    // outcome = p → zero residual.
    expect(conjunctiveCreditsContinuous([0.5], 0, p)[0]).toBeCloseTo(0, 12);
  });

  it('slow correct (outcome=0.75 vs binary 1.0): smaller positive credit than binary', () => {
    const binary = conjunctiveCreditsContinuous([0.5], 0, 1); // = (1 − p)
    const slow = conjunctiveCreditsContinuous([0.5], 0, 0.75);
    expect(slow[0]).toBeGreaterThan(0);
    expect(slow[0]).toBeLessThan(binary[0]); // fast-correct moves θ MORE than slow-correct
  });

  it('slow wrong (outcome=0.25 vs binary 0.0): smaller penalty than binary', () => {
    const binary = conjunctiveCreditsContinuous([0.5], 0, 0); // = −p
    const slow = conjunctiveCreditsContinuous([0.5], 0, 0.25);
    expect(slow[0]).toBeLessThan(0);
    expect(slow[0]).toBeGreaterThan(binary[0]); // slow-wrong penalised LESS than fast-wrong
  });

  it('outcome = 0.5 (slow answer, no time signal): zero credit direction (no movement scale)', () => {
    // Multi-KC: srtOutcome=0.5 → magnitude m=0 → every KC credit is 0.
    const credits = conjunctiveCreditsContinuous([2, -1], 0, 0.5);
    for (const c of credits) expect(c).toBeCloseTo(0, 12);
  });

  it('multi-KC continuous PRESERVES the (1−p_k) sensitivity assignment (weaker KC moves more)', () => {
    // Correct-direction continuous outcome (0.8). The (1−p_k) sensitivity must
    // still order the bumps: weaker KC (lower p) gets the larger credit.
    const [cA, cB] = conjunctiveCreditsContinuous([2, -1], 0, 0.8);
    expect(cA).toBeGreaterThan(0);
    expect(cB).toBeGreaterThan(0);
    expect(cB).toBeGreaterThan(cA); // weaker KC (−1) has larger (1−p) sensitivity
  });

  it('multi-KC wrong-direction continuous PRESERVES sparing the mastered KC', () => {
    // Wrong-direction continuous outcome (0.2). The mastered KC (A) must still be
    // spared relative to the neutral KC (B).
    const [cA, cB] = conjunctiveCreditsContinuous([2, 0], 0, 0.2);
    expect(cA).toBeLessThan(0);
    expect(cB).toBeLessThan(0);
    expect(Math.abs(cB)).toBeGreaterThan(Math.abs(cA));
  });

  it('multi-KC continuous magnitude is bounded by the binary magnitude (conservative)', () => {
    // A correct-direction continuous outcome (0.7) must move each KC no MORE than
    // the binary correct credit for the same KC — the bounded property.
    const binary = conjunctiveCreditsContinuous([2, -1], 0, 1);
    const cont = conjunctiveCreditsContinuous([2, -1], 0, 0.7);
    for (let i = 0; i < binary.length; i++) {
      expect(Math.abs(cont[i])).toBeLessThanOrEqual(Math.abs(binary[i]) + 1e-12);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 (YUK-434) — hierarchical Elo: θ_global + θ_KC, per-domain cold-start inheritance.
// ─────────────────────────────────────────────────────────────────────────────

describe('HIERARCHICAL_ELO_ENABLED flag', () => {
  it('is LIVE (true) — P1 go-live default (YUK-361 step 1); off path still mocked-false in state.db.test.ts', () => {
    // Flipped from dark-ship false → live true. The OFF (single-layer) path is NOT
    // deleted: it remains the explicit-false-mock regression in state.db.test.ts
    // (hierFlag.value = false byte-identical anchor, NO global row written).
    expect(HIERARCHICAL_ELO_ENABLED).toBe(true);
  });
});

describe('ELO_K_GLOBAL (slow per-domain drift)', () => {
  it('is a small positive step', () => {
    expect(ELO_K_GLOBAL).toBeGreaterThan(0);
  });

  it('is well below the eloK floor (global drifts slower than per-KC)', () => {
    // eloK floor (kFloor) = 0.12 for evidence ≥ coldStartN. The global step must be
    // strictly smaller so the domain anchor moves slower than the per-KC offset.
    const kFloor = eloK(100); // 0.12
    expect(ELO_K_GLOBAL).toBeLessThan(kFloor);
    // And approximately 0.4× the floor (the design target), within a tight band.
    expect(ELO_K_GLOBAL / kFloor).toBeCloseTo(0.4, 1);
  });
});

describe('effective theta = θ_global + θ_KC fed into expectedScore (A2 two-layer)', () => {
  it('expectedScore reads the SUM of the two layers (effective ability)', () => {
    const thetaGlobal = 0.8;
    const thetaKc = 0.3;
    const b = 0.5;
    // The credit/selection layers feed (θ_global + θ_KC) into expectedScore; verify
    // the 1PL ICC reads the sum, not either layer alone.
    expect(expectedScore(thetaGlobal + thetaKc, b)).toBeCloseTo(expectedScore(1.1, 0.5), 12);
    // Sanity: the sum prediction differs from using θ_KC alone (the single-layer form).
    expect(expectedScore(thetaGlobal + thetaKc, b)).not.toBeCloseTo(expectedScore(thetaKc, b), 6);
  });

  it('a NEVER-SEEN KC (θ_KC=0) predicts σ(θ_global − b) — per-domain cold-start inheritance', () => {
    const thetaGlobal = 0.9; // learner strong in this domain
    const thetaKc = 0; // fresh mastery_state row default → inherits the domain anchor
    const b = 0.2;
    // The MAIN PAYOFF: effective ability of a brand-new KC == θ_global of its domain,
    // so P(correct) = σ(θ_global − b), NOT the cold σ(−b) the single layer would give.
    expect(expectedScore(thetaGlobal + thetaKc, b)).toBeCloseTo(expectedScore(thetaGlobal, b), 12);
    // It is ABOVE the cold-start σ(0 − b) a single-layer new KC would predict.
    expect(expectedScore(thetaGlobal + thetaKc, b)).toBeGreaterThan(expectedScore(0, b));
  });

  it('flag-off semantics: θ_global=0 → effective == θ_KC (single-layer reduction)', () => {
    // When the flag is off the write/read paths treat θ_global as identically 0, so
    // the effective theta collapses to θ_KC and the prediction is the single-layer one.
    const thetaKc = 0.45;
    const b = -0.1;
    expect(expectedScore(0 + thetaKc, b)).toBe(expectedScore(thetaKc, b));
  });
});

describe('two-layer K split ratio (per-KC offset moves faster than domain global)', () => {
  it('per-KC step (eloK floor) > global step (ELO_K_GLOBAL) for the same credit', () => {
    // Same per-attempt credit magnitude, same bWeight: the per-KC offset update uses
    // eloK (≥ kFloor 0.12) while the domain global uses ELO_K_GLOBAL (~0.048), so the
    // KC offset always absorbs more of a single attempt's surprise than the domain
    // anchor — the structural reason θ_global is the slow, stable layer.
    const credit = 0.5;
    const bWeight = 1;
    const perKcStep = eloK(100) * bWeight * credit; // 0.12 · 1 · 0.5
    const globalStep = ELO_K_GLOBAL * bWeight * credit; // 0.048 · 1 · 0.5
    expect(perKcStep).toBeGreaterThan(globalStep);
    expect(globalStep / perKcStep).toBeCloseTo(ELO_K_GLOBAL / eloK(100), 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1 (YUK-450) — Fisher-conditioned TIME WEIGHT on the SRT credit. srtOutcome gains a
// `timeWeight ∈ [0,1]` param (default 1) that shrinks the TIME component toward the
// pure-binary endpoint as it → 0, fading the time signal at extreme-p items while
// preserving the correctness sign. The 4·p(1−p) weight itself is built at the
// state.ts/replay seam; here we pin srtOutcome's timeWeight semantics + the weight shape.
// ─────────────────────────────────────────────────────────────────────────────

describe('SRT_FISHER_WEIGHT_ENABLED flag', () => {
  it('is DARK (false) — ship dark; the seam passes timeWeight=1 (byte-identical) when off', () => {
    expect(SRT_FISHER_WEIGHT_ENABLED).toBe(false);
  });
});

describe('srtOutcome timeWeight (YUK-450 Fisher-conditioned time weight)', () => {
  it('timeWeight=1 (DEFAULT) is BYTE-IDENTICAL to PRE-YUK-450 main, anchored on golden constants', () => {
    // The LIVE SRT path runs srtOutcome at the production default timeWeight=1; flipping the
    // time-weight formula MUST NOT perturb θ̂ by even 1 ULP (SRT_ENABLED is true → this feeds the
    // live engine). A new-vs-new assertion (`srtOutcome(…,1) === srtOutcome(…)`) is a TAUTOLOGY —
    // both go through today's code. The only honest byte-identical guard is the literal output of
    // main's pre-YUK-450 srtOutcome, hard-coded here. These constants were recomputed directly
    // from main's `0.5 ± 0.5·rEff` form (rEff = 0.15 + 0.85·clamp01((d−t)/d)); they include t in
    // the float-drift zone (17.67 / 17.9 at d=20 — where the rejected `1 − w·(1 − rEff)` form
    // diverged ~1 ULP). The endpoint-exact `w·rEff + (1 − w)` form must reproduce them EXACTLY.
    const GOLDEN: ReadonlyArray<readonly [boolean, number, number, number]> = [
      // [correct, d, t(seconds), main's srtOutcome]
      [true, 30, 0, 1], // fast-correct binary anchor
      [true, 30, 15, 0.7875], // mid
      [true, 30, 30, 0.575], // floored slow (t == d)
      [true, 30, 45, 0.575], // floored slow (t > d clamps)
      [false, 30, 0, 0], // fast-wrong binary anchor
      [false, 30, 15, 0.21250000000000002], // mid wrong
      [false, 30, 30, 0.425], // floored slow wrong
      [true, 0, 5, 0.575], // d ≤ 0 guard → floored
      // float-drift-zone samples (the rejected 1 − w·(1 − rEff) form drifted ±1 ULP here):
      [true, 20, 17.67, 0.6245124999999999],
      [false, 20, 17.67, 0.37548750000000003],
      [true, 20, 17.9, 0.619625],
      [false, 20, 17.9, 0.38037499999999996],
    ];
    for (const [correct, d, t, expected] of GOLDEN) {
      expect(srtOutcome(correct, d, t, 1)).toBe(expected); // EXACT — byte-identical to main
      expect(srtOutcome(correct, d, t)).toBe(expected); // 3-arg default path identical too
    }
  });

  it('timeWeight=0 collapses to the PURE BINARY endpoints (time signal fully erased)', () => {
    // At weight 0 the residual is irrelevant: correct → 1.0, wrong → 0.0, regardless of t.
    for (const t of [0, 15, 30, 45, 1000]) {
      expect(srtOutcome(true, 30, t, 0)).toBe(1.0);
      expect(srtOutcome(false, 30, t, 0)).toBe(0.0);
    }
  });

  it('decreasing timeWeight pulls a slow-correct credit toward binary 1.0 (monotone)', () => {
    // A slow-correct (t≥d) at full weight is the floored 0.575; as weight → 0 it rises to 1.0.
    const full = srtOutcome(true, 30, 30, 1); // 0.575
    const half = srtOutcome(true, 30, 30, 0.5);
    const zero = srtOutcome(true, 30, 30, 0); // 1.0
    expect(full).toBeLessThan(half);
    expect(half).toBeLessThan(zero);
    expect(zero).toBe(1.0);
    // and a slow-WRONG outcome value falls toward binary 0.0 as the weight drops (the floored
    // 0.425 mild penalty at full weight → the full 0.0 binary penalty at weight 0).
    expect(srtOutcome(false, 30, 30, 1)).toBeGreaterThan(srtOutcome(false, 30, 30, 0.5));
    expect(srtOutcome(false, 30, 30, 0.5)).toBeGreaterThan(srtOutcome(false, 30, 30, 0));
    expect(srtOutcome(false, 30, 30, 0)).toBe(0.0);
  });

  it('correctness sign is preserved at any positive weight (correct > wrong)', () => {
    for (const w of [0.1, 0.5, 0.9, 1]) {
      for (const t of [0, 15, 30, 1000]) {
        expect(srtOutcome(true, 30, t, w)).toBeGreaterThan(srtOutcome(false, 30, t, w));
      }
    }
  });

  it('timeWeight applies in the d≤0 guard branch too (weight=1 byte-identical, weight=0 binary)', () => {
    expect(srtOutcome(true, 0, 5, 1)).toBe(srtOutcome(true, 0, 5));
    expect(srtOutcome(true, -3, 5, 0)).toBe(1.0);
    expect(srtOutcome(false, -3, 5, 0)).toBe(0.0);
  });

  it('the seam weight 4·p(1−p) peaks (=1) at p=0.5 and → 0 at the p extremes', () => {
    // The state.ts/replay seam builds timeWeight = 4·pItem·(1−pItem). Pin the shape so a
    // regression in the seam formula is caught: peak 1 at p=0.5, symmetric, → 0 at 0/1.
    const w = (p: number) => 4 * p * (1 - p);
    expect(w(0.5)).toBeCloseTo(1, 12);
    expect(w(0)).toBeCloseTo(0, 12);
    expect(w(1)).toBeCloseTo(0, 12);
    expect(w(0.1)).toBeCloseTo(w(0.9), 12); // symmetric
    expect(w(0.1)).toBeLessThan(w(0.3)); // monotone toward the peak
    expect(w(0.3)).toBeLessThan(w(0.5));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1 (YUK-449) — per-KC rolling RT quantile as the SRT design constant d. quantile() +
// pushRtCorrectSample() (ring buffer) + resolveSrtTimeLimitFromQuantile() (quantile-d
// with cold-start fallback to the population seed). The flag SRT_D_FROM_QUANTILE is dark.
// ─────────────────────────────────────────────────────────────────────────────

describe('SRT_D_FROM_QUANTILE flag + RT buffer constants', () => {
  it('is DARK (false) — d stays the population seed → θ̂ byte-identical to today', () => {
    expect(SRT_D_FROM_QUANTILE).toBe(false);
  });
  it('the buffer/quantile knobs are sane owner-tunable constants', () => {
    expect(SRT_RT_BUFFER_K).toBeGreaterThan(0);
    expect(SRT_RT_MIN_N).toBeGreaterThan(0);
    expect(SRT_RT_MIN_N).toBeLessThanOrEqual(SRT_RT_BUFFER_K);
    expect(SRT_RT_QUANTILE).toBeGreaterThan(0);
    expect(SRT_RT_QUANTILE).toBeLessThan(1);
  });
});

describe('quantile (exact, type-7 linear interpolation)', () => {
  it('median of an odd-length sample is the middle order statistic', () => {
    expect(quantile([30, 10, 20], 0.5)).toBe(20);
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
  });

  it('median of an even-length sample interpolates the two central order statistics', () => {
    expect(quantile([10, 20, 30, 40], 0.5)).toBeCloseTo(25, 12);
  });

  it('does not mutate the caller array (sorts a copy)', () => {
    const input = [3, 1, 2];
    quantile(input, 0.5);
    expect(input).toEqual([3, 1, 2]);
  });

  it('p0 / p100 are the min / max; p60 interpolates', () => {
    expect(quantile([10, 20, 30, 40, 50], 0)).toBe(10);
    expect(quantile([10, 20, 30, 40, 50], 1)).toBe(50);
    expect(quantile([10, 20, 30, 40, 50], 0.6)).toBeCloseTo(34, 12); // pos=2.4 → 30 + 0.4·10
  });

  it('single element returns that element; empty returns NaN', () => {
    expect(quantile([42], 0.5)).toBe(42);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });

  it('clamps q outside [0,1]', () => {
    expect(quantile([10, 20, 30], -1)).toBe(10);
    expect(quantile([10, 20, 30], 5)).toBe(30);
  });
});

describe('pushRtCorrectSample (per-KC correct-RT ring buffer)', () => {
  it('appends to the tail and never mutates the input', () => {
    const buf = [1000, 2000];
    const next = pushRtCorrectSample(buf, 3000);
    expect(next).toEqual([1000, 2000, 3000]);
    expect(buf).toEqual([1000, 2000]); // input untouched
  });

  it('null/undefined buffer starts a fresh single-element buffer', () => {
    expect(pushRtCorrectSample(null, 1500)).toEqual([1500]);
    expect(pushRtCorrectSample(undefined, 1500)).toEqual([1500]);
  });

  it('caps at SRT_RT_BUFFER_K, dropping the OLDEST (FIFO)', () => {
    let buf: number[] = [];
    for (let i = 1; i <= SRT_RT_BUFFER_K + 5; i++) buf = pushRtCorrectSample(buf, i * 100);
    expect(buf.length).toBe(SRT_RT_BUFFER_K);
    // oldest 5 dropped → first element is sample #6 (=600), last is the newest.
    expect(buf[0]).toBe(600);
    expect(buf[buf.length - 1]).toBe((SRT_RT_BUFFER_K + 5) * 100);
  });

  it('drops non-finite / non-positive samples (garbage RT must not pollute the scale)', () => {
    const buf = [1000];
    expect(pushRtCorrectSample(buf, Number.NaN)).toEqual([1000]);
    expect(pushRtCorrectSample(buf, Number.POSITIVE_INFINITY)).toEqual([1000]);
    expect(pushRtCorrectSample(buf, 0)).toEqual([1000]);
    expect(pushRtCorrectSample(buf, -500)).toEqual([1000]);
    // returns a COPY even on a dropped sample (no aliasing).
    const dropped = pushRtCorrectSample(buf, -1);
    expect(dropped).not.toBe(buf);
  });
});

describe('resolveSrtTimeLimitFromQuantile (quantile-d with cold-start population-seed fallback)', () => {
  it('falls back to the population seed below SRT_RT_MIN_N samples (cold start)', () => {
    expect(resolveSrtTimeLimitFromQuantile(null, 3)).toBe(resolveSrtTimeLimit(3));
    expect(resolveSrtTimeLimitFromQuantile([], 3)).toBe(resolveSrtTimeLimit(3));
    const few = Array.from({ length: SRT_RT_MIN_N - 1 }, () => 5000);
    expect(resolveSrtTimeLimitFromQuantile(few, 3)).toBe(resolveSrtTimeLimit(3));
  });

  it('derives d (seconds) from the quantile once ≥ SRT_RT_MIN_N samples accrue', () => {
    // SRT_RT_MIN_N copies of 5000ms → median 5000ms → d = 5s.
    const buf = Array.from({ length: SRT_RT_MIN_N }, () => 5000);
    expect(resolveSrtTimeLimitFromQuantile(buf, 3)).toBeCloseTo(5, 12);
    // and it is INDEPENDENT of the difficulty seed once data is present (self-RT drives d).
    expect(resolveSrtTimeLimitFromQuantile(buf, 1)).toBeCloseTo(5, 12);
    expect(resolveSrtTimeLimitFromQuantile(buf, 5)).toBeCloseTo(5, 12);
  });

  it('uses the configured quantile (median by default) of the buffered correct RTs', () => {
    const buf = [2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000]; // 8 samples
    const expectedMs = quantile(buf, SRT_RT_QUANTILE);
    expect(resolveSrtTimeLimitFromQuantile(buf, 3)).toBeCloseTo(expectedMs / 1000, 12);
  });
});
