// A4 (YUK-436) — discrete grid-Bayes θ_KC offset posterior, unit tests (no DB).

import { describe, expect, it } from 'vitest';

import { expectedScore, fisherInformation } from './theta';
import {
  GRID_MAX,
  GRID_MIN,
  GRID_POINTS,
  GRID_STEP,
  GRID_THETA,
  THETA_GRID_ENABLED,
  type ThetaGridPosterior,
  binaryLikelihood,
  continuousCbLikelihood,
  gridUpdate,
  klpScoreFromGrid,
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
