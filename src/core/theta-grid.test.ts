// A4 (YUK-436) — discrete grid-Bayes θ_KC offset posterior, unit tests (no DB).

import { describe, expect, it } from 'vitest';

import { expectedScore, fisherInformation, fisherInformation3pl } from './theta';
import {
  GRID_MAX,
  GRID_MIN,
  GRID_POINTS,
  GRID_STEP,
  GRID_THETA,
  THETA_GRID_ENABLED,
  type ThetaGridPosterior,
  binaryLikelihood,
  choicesToGuess,
  continuousCbLikelihood,
  gridUpdate,
  isGraduationCandidate,
  klpScoreFromGrid,
  masterySnapshot,
  posteriorMassAbove,
  posteriorMean,
  posteriorSe,
  posteriorVar,
  uniformPrior,
} from './theta-grid';

/** Build a posterior with all mass on the grid point exactly equal to `offset`. */
function pointPosterior(offset: number): ThetaGridPosterior {
  const idx = GRID_THETA.indexOf(offset);
  if (idx < 0) throw new Error(`offset ${offset} is not a grid point`);
  return { probs: GRID_THETA.map((_, i) => (i === idx ? 1 : 0)), evidence: 1 };
}

describe('theta-grid constants', () => {
  it('dark-ships: THETA_GRID_ENABLED is false (flag-gated, no live reader inc-1)', () => {
    expect(THETA_GRID_ENABLED).toBe(false);
  });

  it('grid = [-4, 4] × 41 points at 0.2 logit step, origin lands EXACTLY on 0', () => {
    expect(GRID_MIN).toBe(-4);
    expect(GRID_MAX).toBe(4);
    expect(GRID_POINTS).toBe(41);
    expect(GRID_STEP).toBeCloseTo(0.2, 12);
    expect(GRID_THETA).toHaveLength(41);
    expect(GRID_THETA[0]).toBeCloseTo(-4, 12);
    expect(GRID_THETA[40]).toBeCloseTo(4, 12);
    // 41 points (odd) ⇒ index 20 is exactly the offset origin 0 (cold-start prior mode).
    expect(GRID_THETA[20]).toBeCloseTo(0, 12);
  });
});

describe('uniformPrior', () => {
  it('is uniform mass 1/41 per point, sums to 1, evidence 0', () => {
    const prior = uniformPrior();
    expect(prior.probs).toHaveLength(GRID_POINTS);
    for (const m of prior.probs) expect(m).toBeCloseTo(1 / GRID_POINTS, 12);
    expect(prior.probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(prior.evidence).toBe(0);
    // The uniform prior mean is the origin offset 0 (symmetric grid).
    expect(posteriorMean(prior)).toBeCloseTo(0, 12);
  });
});

describe('binaryLikelihood — 1PL ICC at b prime = b - theta_global', () => {
  it('correct ⇒ σ(offset − b prime); wrong ⇒ 1 − σ(offset − b prime)', () => {
    const offset = 0.5;
    const bPrime = 0.2;
    const p = expectedScore(offset, bPrime);
    expect(binaryLikelihood(offset, bPrime, 1)).toBeCloseTo(p, 12);
    expect(binaryLikelihood(offset, bPrime, 0)).toBeCloseTo(1 - p, 12);
  });

  it('b prime ENCODES the θ_global translation anchor: b prime = b − θ_global', () => {
    // Effective ability = θ_global + offset; ICC reads σ(effective − b) = σ(offset − (b−θ_global)).
    const offset = 0.7;
    const b = 1.0;
    const thetaGlobal = 0.4;
    const bPrime = b - thetaGlobal; // 0.6
    // Likelihood at the offset with the shifted anchor == ICC at the effective ability.
    expect(binaryLikelihood(offset, bPrime, 1)).toBeCloseTo(
      expectedScore(thetaGlobal + offset, b),
      12,
    );
  });

  it('θ_global = 0 (pre-A2 default) ⇒ b prime = b, grid is over raw offset', () => {
    const offset = -0.3;
    const b = 0.5;
    expect(binaryLikelihood(offset, b - 0, 1)).toBeCloseTo(expectedScore(offset, b), 12);
  });
});

describe('gridUpdate — sequential Bayes (n=1-legal, b locked)', () => {
  it('posterior ∝ prior · likelihood; renormalises to sum 1; folds one evidence', () => {
    const prior = uniformPrior();
    const post = gridUpdate(prior, 0, 1); // correct at b'=0
    expect(post.probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(post.evidence).toBe(1);
    // Each posterior mass = (1/41)·L_i / Σ(1/41·L_j) = L_i / ΣL_j, L_i = σ(offset_i).
    const ls = GRID_THETA.map((t) => expectedScore(t, 0));
    const z = ls.reduce((a, b) => a + b, 0);
    for (let i = 0; i < GRID_POINTS; i++) {
      expect(post.probs[i]).toBeCloseTo(ls[i] / z, 10);
    }
  });

  it('does NOT mutate the prior (pure)', () => {
    const prior = uniformPrior();
    const before = [...prior.probs];
    gridUpdate(prior, 0.5, 1);
    expect(prior.probs).toEqual(before);
    expect(prior.evidence).toBe(0);
  });

  it('a CORRECT answer shifts the posterior mean UP; a WRONG answer shifts it DOWN', () => {
    const prior = uniformPrior();
    const afterCorrect = gridUpdate(prior, 0, 1);
    const afterWrong = gridUpdate(prior, 0, 0);
    expect(posteriorMean(afterCorrect)).toBeGreaterThan(0);
    expect(posteriorMean(afterWrong)).toBeLessThan(0);
  });

  it('more consistent evidence SHRINKS the posterior SE (information accumulates)', () => {
    let post = uniformPrior();
    const sePrior = posteriorSe(post);
    for (let n = 0; n < 8; n++) post = gridUpdate(post, 0, 1); // 8 consecutive correct at b'=0
    expect(post.evidence).toBe(8);
    expect(posteriorSe(post)).toBeLessThan(sePrior); // peak sharpened ⇒ smaller SE
    expect(posteriorMean(post)).toBeGreaterThan(0); // mass moved to positive offsets
  });

  it('θ_global anchor shifts the posterior: harder effective item (larger b) lowers the mean for a correct answer less', () => {
    // Same correct outcome, two anchors. The posterior peak tracks where σ(offset − b')
    // best explains "correct": a larger b' pushes the explaining offset higher.
    const easy = gridUpdate(uniformPrior(), -1, 1); // b'=-1
    const hard = gridUpdate(uniformPrior(), 1, 1); // b'=+1
    expect(posteriorMean(hard)).toBeGreaterThan(posteriorMean(easy));
  });

  it('degenerate likelihood (∼0 over whole grid) falls back to prior shape, still counts evidence', () => {
    // Construct a near-impossible prior/likelihood: a prior concentrated where the
    // likelihood is ~0 forces total→0; we must not emit NaNs.
    const spiked: ThetaGridPosterior = {
      probs: GRID_THETA.map((t) => (t === GRID_MAX ? 1 : 0)),
      evidence: 3,
    };
    // wrong answer at an extreme-easy anchor b'=-50 ⇒ 1−σ(4+50) ≈ 0 everywhere.
    const post = gridUpdate(spiked, -50, 0);
    expect(post.probs.every((m) => Number.isFinite(m))).toBe(true);
    expect(post.evidence).toBe(4); // evidence still folded
  });
});

describe('posterior moments', () => {
  it('uniform prior: mean 0, variance > 0, SE = √var', () => {
    const prior = uniformPrior();
    expect(posteriorMean(prior)).toBeCloseTo(0, 12);
    const v = posteriorVar(prior);
    expect(v).toBeGreaterThan(0);
    expect(posteriorSe(prior)).toBeCloseTo(Math.sqrt(v), 12);
  });

  it('a sharply peaked posterior has SE → 0', () => {
    const peaked: ThetaGridPosterior = {
      probs: GRID_THETA.map((t) => (t === 0 ? 1 : 0)),
      evidence: 99,
    };
    expect(posteriorMean(peaked)).toBeCloseTo(0, 12);
    expect(posteriorVar(peaked)).toBeCloseTo(0, 12);
    expect(posteriorSe(peaked)).toBeCloseTo(0, 12);
  });
});

describe('continuousCbLikelihood — GATED stub (NOT wired inc-1)', () => {
  it('reduces BIT-EXACTLY to binaryLikelihood at the binary endpoints srt ∈ {0,1}', () => {
    const offset = 0.3;
    const bPrime = -0.2;
    expect(continuousCbLikelihood(offset, bPrime, 1)).toBe(binaryLikelihood(offset, bPrime, 1));
    expect(continuousCbLikelihood(offset, bPrime, 0)).toBe(binaryLikelihood(offset, bPrime, 0));
  });

  it('interpolates monotonically between the wrong/correct endpoints for srt ∈ (0,1)', () => {
    const offset = 0.6;
    const bPrime = 0.1;
    const lo = continuousCbLikelihood(offset, bPrime, 0);
    const mid = continuousCbLikelihood(offset, bPrime, 0.5);
    const hi = continuousCbLikelihood(offset, bPrime, 1);
    // p = σ(0.5) > 0.5 ⇒ correct endpoint (p) > wrong endpoint (1−p); mid between.
    expect(hi).toBeGreaterThan(lo);
    expect(mid).toBeGreaterThan(Math.min(lo, hi));
    expect(mid).toBeLessThan(Math.max(lo, hi));
  });
});

describe('klpScoreFromGrid — posterior-weighted Fisher over the ACTUAL grid (A4 inc-2 selection wiring)', () => {
  it('a point-mass posterior reduces to point Fisher at the effective ability θ_global + offset', () => {
    // mass on offset 0, θ_global=0.5, b=0.5 ⇒ effective=0.5=b ⇒ Fisher peak 0.25.
    const score = klpScoreFromGrid(pointPosterior(0), 0.5, 0.5);
    expect(score).toBeCloseTo(fisherInformation(0.5, 0.5), 12);
    expect(score).toBeCloseTo(0.25, 12);
  });

  it('θ_global translates the effective ability (offset grid is over θ_KC, anchored by θ_global)', () => {
    // Same point offset 0 and b=0; θ_global=0 sits at the Fisher peak (eff=b=0 ⇒ 0.25),
    // θ_global=1 moves the effective ability off the peak ⇒ strictly less information.
    const atPeak = klpScoreFromGrid(pointPosterior(0), 0, 0);
    const offPeak = klpScoreFromGrid(pointPosterior(0), 0, 1);
    expect(atPeak).toBeCloseTo(0.25, 12);
    expect(offPeak).toBeLessThan(atPeak);
    expect(offPeak).toBeCloseTo(fisherInformation(1, 0), 12);
  });

  it('a spread posterior is more conservative than the point estimate at the Fisher peak (KLP behavior)', () => {
    // Uniform posterior over the whole offset grid vs a point at the peak. With b at the
    // posterior mean (effective peak), the spread mass sits on lower-information offsets ⇒
    // posterior-weighted Fisher < the point peak 0.25.
    const uniform = uniformPrior(); // mean offset 0
    const thetaGlobal = 0;
    const b = 0; // peak at effective = 0 = θ_global + mean offset
    const spread = klpScoreFromGrid(uniform, b, thetaGlobal);
    const point = klpScoreFromGrid(pointPosterior(0), b, thetaGlobal);
    expect(point).toBeCloseTo(0.25, 12);
    expect(spread).toBeLessThan(point);
    expect(spread).toBeGreaterThan(0);
  });

  it('result is always in (0, 0.25] (a probability-weighted average of Fisher ∈ (0,0.25])', () => {
    const score = klpScoreFromGrid(uniformPrior(), 1.3, -0.4);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(0.25);
  });

  it('equals the manual Σ probs_i · fisherInformation(θ_global + GRID_THETA_i, b)', () => {
    const post = gridUpdate(gridUpdate(uniformPrior(), 0.3, 1), -0.5, 0);
    const b = 0.2;
    const thetaGlobal = 0.7;
    const manual = post.probs.reduce(
      (acc, p, i) => acc + p * fisherInformation(thetaGlobal + GRID_THETA[i], b),
      0,
    );
    expect(klpScoreFromGrid(post, b, thetaGlobal)).toBeCloseTo(manual, 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKT graft 1 — 3PL lower-asymptote (c = 1/k guess). DARK-SHIP, n=1-legal.
// ─────────────────────────────────────────────────────────────────────────────

describe('fisherInformation3pl — 3PL Fisher (theta.ts)', () => {
  it('c=0 reduces BIT-EXACTLY to fisherInformation (1PL regression anchor)', () => {
    for (const [theta, b] of [
      [0, 0],
      [0.5, 0.2],
      [-1.3, 0.7],
      [2.1, -0.4],
    ] as const) {
      expect(fisherInformation3pl(theta, b, 0)).toBe(fisherInformation(theta, b));
    }
  });

  it('c>0 (choice item): at θ=b, Fisher is STRICTLY LESS than 1PL peak 0.25', () => {
    // 3PL raises P(correct) by c, so at θ=b: P=0.5+c·0.5 > 0.5 ⇒ moves off the
    // Fisher peak ⇒ strictly less information than the 1PL 0.25.
    const c = 1 / 4; // 4-choice item
    expect(fisherInformation3pl(0, 0, c)).toBeLessThan(0.25);
    expect(fisherInformation3pl(0, 0, c)).toBeGreaterThan(0);
  });

  it('c=1/4 at θ=b=0 pins the EXACT analytic Fisher 0.15 (distinguishes the wrong denominator)', () => {
    // Analytic derivation at θ=b=0, c=1/4 — a closed-form rational the inequality
    // assertions above cannot uniquely pin (a wrong denominator like (1−c)²·p̂·q̂ yields
    // 0.140625 here and passes <0.25 / >0 / monotone-in-c just the same):
    //   p̂ = σ(0) = 0.5
    //   P  = c + (1−c)·p̂ = 0.25 + 0.75·0.5 = 0.625
    //   dP = (1−c)·p̂·(1−p̂) = 0.75·0.25 = 0.1875
    //   I  = (dP)² / [P·(1−P)] = 0.1875² / (0.625·0.375) = 0.03515625 / 0.234375 = 0.15
    // exact 0.15 rational ⇒ the correct P·(1−P) denominator vs the erroneous p̂·q̂ variant.
    expect(fisherInformation3pl(0, 0, 0.25)).toBeCloseTo(0.15, 12);
  });

  it('c>0: larger k (smaller c) approaches 1PL Fisher monotonically', () => {
    // As k→∞, c→0, 3PL→1PL. Information at the peak should increase toward 0.25 as c shrinks.
    const atB4 = fisherInformation3pl(0, 0, 1 / 4);
    const atB5 = fisherInformation3pl(0, 0, 1 / 5);
    const atB10 = fisherInformation3pl(0, 0, 1 / 10);
    expect(atB4).toBeLessThan(atB5);
    expect(atB5).toBeLessThan(atB10);
    expect(atB10).toBeLessThan(0.25);
  });
});

describe('choicesToGuess — n=1-legal c=1/k bridge from choices_md', () => {
  it('null / undefined / empty / single → 0 (1PL degenerate, non-choice)', () => {
    expect(choicesToGuess(null)).toBe(0);
    expect(choicesToGuess(undefined)).toBe(0);
    expect(choicesToGuess([])).toBe(0);
    expect(choicesToGuess(['only-one'])).toBe(0);
  });

  it('k choices → exactly 1/k (design constant, NOT a fit param)', () => {
    expect(choicesToGuess(['a', 'b'])).toBeCloseTo(0.5, 12);
    expect(choicesToGuess(['a', 'b', 'c', 'd'])).toBeCloseTo(0.25, 12);
    expect(choicesToGuess(Array.from({ length: 6 }, (_, i) => `${i}`))).toBeCloseTo(1 / 6, 12);
  });

  it('domain property (CR-1/CR-3): range is exactly {0} ∪ (0, 1/2] — never c≥1', () => {
    // The producer's structural range guarantees the c-domain the 3PL consumers assume:
    // ∀k∈[2..6]: 0 < 1/k ≤ 1/2 (k=2 hits the 1/2 supremum; larger k strictly smaller).
    for (let k = 2; k <= 6; k++) {
      const c = choicesToGuess(Array.from({ length: k }, (_, i) => `${i}`));
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThanOrEqual(0.5);
      expect(c).toBeCloseTo(1 / k, 12);
    }
    // k≤1 (single/empty/null) collapses to c=0 (the 1PL non-choice degenerate) — the
    // producer NEVER emits c in (1/2, 1) or c≥1, so consumers can assume c ∈ [0, 1).
    expect(choicesToGuess([])).toBe(0);
    expect(choicesToGuess(['only'])).toBe(0);
  });
});

describe('binaryLikelihood / gridUpdate / klpScoreFromGrid — 3PL c param', () => {
  it('c=0 default is BIT-IDENTICAL to the no-arg call (regression anchor preserved)', () => {
    const offset = 0.4;
    const bPrime = -0.1;
    expect(binaryLikelihood(offset, bPrime, 1, 0)).toBe(binaryLikelihood(offset, bPrime, 1));
    expect(binaryLikelihood(offset, bPrime, 0, 0)).toBe(binaryLikelihood(offset, bPrime, 0));
    // gridUpdate: c=0 explicit == c=0 default.
    const prior = uniformPrior();
    expect(gridUpdate(prior, 0.3, 1, 0)).toEqual(gridUpdate(prior, 0.3, 1));
    // klpScore: c=0 explicit takes the SAME code path as default (fisherInformation3pl
    // delegates c===0 to fisherInformation) ⇒ bit-exact, pin with toBe not toBeCloseTo.
    expect(klpScoreFromGrid(prior, 0.2, 0.5, 0)).toBe(klpScoreFromGrid(prior, 0.2, 0.5));
  });

  it('c=1 (OUT OF DOMAIN): gridUpdate degrades GRACEFULLY both ways (pins degradation, NOT support)', () => {
    // c=1 is OUT OF the producer domain (choicesToGuess returns c ∈ {0}∪(0,1/2], never 1).
    // This pins the graceful-degradation behaviour if bad wiring ever leaked c=1 — it does
    // NOT assert c=1 is supported:
    //   correct ⇒ likelihood ≡ c+(1−c)·p̂ = 1 for every offset ⇒ flat multiply ⇒ posterior
    //             renormalises back to the (identical-shape) prior.
    //   wrong   ⇒ likelihood ≡ (1−c)·(1−p̂) = 0 for every offset ⇒ total=0 ⇒ degenerate
    //             guard falls back to the prior shape (no NaNs).
    const prior = uniformPrior();
    const correct = gridUpdate(prior, 0.3, 1, 1);
    const wrong = gridUpdate(prior, 0.3, 0, 1);
    for (let i = 0; i < GRID_POINTS; i++) {
      expect(correct.probs[i]).toBeCloseTo(prior.probs[i], 12); // shape == prior
      expect(wrong.probs[i]).toBeCloseTo(prior.probs[i], 12); // degenerate fallback == prior
    }
    expect(correct.probs.every((m) => Number.isFinite(m))).toBe(true);
    expect(wrong.probs.every((m) => Number.isFinite(m))).toBe(true);
    expect(correct.evidence).toBe(1);
    expect(wrong.evidence).toBe(1);
  });

  it('3PL correct likelihood RAISES the floor by c (guess helps low-ability correct)', () => {
    // At a very negative offset (p̂≈0), 1PL says P(correct)≈0; 3PL says P(correct)≈c.
    const offset = GRID_MIN; // -4
    const bPrime = 0;
    const c = 0.25;
    const pl1 = binaryLikelihood(offset, bPrime, 1); // 1PL ≈ σ(-4) ≈ 0.018
    const pl3 = binaryLikelihood(offset, bPrime, 1, c); // 3PL ≈ 0.25 + 0.75·0.018
    expect(pl3).toBeGreaterThan(pl1);
    expect(pl3).toBeCloseTo(c + (1 - c) * expectedScore(offset, bPrime), 12);
    // And the floor asymptote approaches c (never below c).
    expect(pl3).toBeGreaterThan(c - 1e-9);
  });

  it('3PL wrong likelihood = (1−c)·(1−p̂), strictly below 1PL (1−p̂) for c>0', () => {
    const offset = 0.5;
    const bPrime = 0.3;
    const c = 0.2;
    const wrong1 = binaryLikelihood(offset, bPrime, 0); // 1−p̂
    const wrong3 = binaryLikelihood(offset, bPrime, 0, c); // (1−c)(1−p̂)
    expect(wrong3).toBeCloseTo((1 - c) * (1 - expectedScore(offset, bPrime)), 12);
    expect(wrong3).toBeLessThan(wrong1);
  });

  it('3PL gridUpdate still renormalises to sum 1 and folds evidence', () => {
    const post = gridUpdate(uniformPrior(), 0.3, 1, 0.25);
    expect(post.probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(post.evidence).toBe(1);
  });

  it('klpScoreFromGrid with c>0: a point-mass reduces to point 3PL Fisher', () => {
    const b = 0.5;
    const thetaGlobal = 0.5;
    const c = 0.25;
    // point mass on offset 0 ⇒ effective = θ_global + 0 = 0.5 = b.
    const score = klpScoreFromGrid(pointPosterior(0), b, thetaGlobal, c);
    expect(score).toBeCloseTo(fisherInformation3pl(thetaGlobal, b, c), 12);
    // strictly less than the 1PL peak (same item, guess erodes information).
    expect(score).toBeLessThan(fisherInformation(thetaGlobal, b));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKT graft 2 — mastery transition pure functions (no IO, caller owns trajectory).
// ─────────────────────────────────────────────────────────────────────────────

describe('posteriorMassAbove — p_mastery = mass at/above mastery line (bPrime)', () => {
  it('uniform prior: mass ≥ 0 = 21/41 (origin counts — 41-point ODD grid, ≥ semantics)', () => {
    // 41 points symmetric about 0 WITH a point exactly at 0 (index 20). "以上" = ≥,
    // so the origin + 20 positive points = 21 of 41 carry mass above the mastery line.
    expect(posteriorMassAbove(uniformPrior(), 0)).toBeCloseTo(21 / 41, 12);
  });

  it('mass above GRID_MAX = 0; mass above GRID_MIN-ε = 1', () => {
    expect(posteriorMassAbove(uniformPrior(), GRID_MAX)).toBeCloseTo(1 / GRID_POINTS, 12);
    expect(posteriorMassAbove(uniformPrior(), GRID_MAX + 1)).toBe(0);
    expect(posteriorMassAbove(uniformPrior(), GRID_MIN - 1)).toBeCloseTo(1, 12);
  });

  it('a correct-at-bPrime=0 posterior concentrates mass above 0 (> uniform)', () => {
    const post = gridUpdate(uniformPrior(), 0, 1);
    expect(posteriorMassAbove(post, 0)).toBeGreaterThan(posteriorMassAbove(uniformPrior(), 0));
  });

  it('threshold = bPrime encodes the θ_global translation (== mass above effective θ*)', () => {
    // θ*=0.5 mastery line, θ_global=0.2 ⇒ offset threshold = 0.5−0.2 = 0.3 = bPrime.
    // Mass above effective θ* (θ_global+offset≥θ*) must equal mass above offset≥0.3.
    const thetaGlobal = 0.2;
    const b = 0.5;
    const bPrime = b - thetaGlobal; // 0.3
    const post = gridUpdate(uniformPrior(), bPrime, 1);
    // effective-ability mass-above: Σ mass_i over θ_global+GRID_THETA_i ≥ b ⇔ GRID_THETA_i ≥ bPrime.
    const effMass = post.probs.reduce(
      (acc, m, i) => acc + (thetaGlobal + GRID_THETA[i] >= b ? m : 0),
      0,
    );
    expect(posteriorMassAbove(post, bPrime)).toBeCloseTo(effMass, 12);
  });
});

describe('masterySnapshot — p_mastery + width derived read', () => {
  it('uniform prior: p_mastery = 21/41 (origin counts), width = posteriorSe', () => {
    const prior = uniformPrior();
    const snap = masterySnapshot(prior, 0);
    expect(snap.pMastery).toBeCloseTo(21 / 41, 12);
    expect(snap.width).toBeCloseTo(posteriorSe(prior), 12);
  });
});

describe('isGraduationCandidate — graduation trigger (N consecutive + ε + M)', () => {
  const cfg = { pMasteryMin: 0.8, widthMax: 0.5, consecutiveN: 3, evidenceMin: 8 };
  // pointPosterior(0): all mass on offset 0 (a real grid point via indexOf) ⇒ p_mastery
  // (mass ≥ bPrime=0) = 1, width = posteriorSe of a point mass = 0.
  const peaked: ThetaGridPosterior = { ...pointPosterior(0), evidence: 10 };
  const goodSnap = masterySnapshot(peaked, 0); // pMastery=1, width=0

  it('rejects when evidence < M (not enough information yet)', () => {
    const thin: ThetaGridPosterior = { ...peaked, evidence: 3 };
    expect(isGraduationCandidate(thin, [goodSnap, goodSnap, goodSnap], cfg)).toBe(false);
  });

  it('rejects when fewer than N=3 recent snapshots (trajectory too short)', () => {
    expect(isGraduationCandidate(peaked, [goodSnap, goodSnap], cfg)).toBe(false);
  });

  it('graduates when evidence≥M AND last N snapshots all clear p>0.8 && width<ε', () => {
    expect(isGraduationCandidate(peaked, [goodSnap, goodSnap, goodSnap], cfg)).toBe(true);
    // 4 snapshots, last 3 all good (the first one being bad is fine — tail-only).
    const badSnap = { pMastery: 0.2, width: 2 };
    expect(isGraduationCandidate(peaked, [badSnap, goodSnap, goodSnap, goodSnap], cfg)).toBe(true);
  });

  it('rejects if ANY of the last N snapshots fails (a recent dip)', () => {
    expect(
      isGraduationCandidate(peaked, [goodSnap, goodSnap, { pMastery: 0.3, width: 2 }], cfg),
    ).toBe(false);
  });

  it('uses handoff defaults when cfg omitted: p>0.8, width<1.0, N=3, M=8', () => {
    // With defaults: a peaked posterior (width 0, pMastery 1) at evidence 8 graduates.
    const atMinEvidence = { ...peaked, evidence: 8 };
    expect(isGraduationCandidate(atMinEvidence, [goodSnap, goodSnap, goodSnap])).toBe(true);
  });

  it('FAIL-CLOSED (CR-2): consecutiveN <= 0 rejects (empty window must NOT vacuously graduate)', () => {
    // slice(length) = [] and every([]) ≡ true — without the guard a consecutiveN<=0 config
    // would graduate on a ZERO-length window. The gate must fail closed on bad config.
    expect(
      isGraduationCandidate(peaked, [goodSnap, goodSnap, goodSnap], { ...cfg, consecutiveN: 0 }),
    ).toBe(false);
    expect(
      isGraduationCandidate(peaked, [goodSnap, goodSnap, goodSnap], { ...cfg, consecutiveN: -1 }),
    ).toBe(false);
  });
});
