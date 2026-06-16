// YUK-361 Phase 7 (Task 12) — unit tests for the offline Urnings replay estimators.
//
// This is where correctness is PINNED: real attempt data is sparse on the n=1
// post-rebuild stack, so the four estimators' update math + the metrics are
// asserted against a SYNTHETIC deterministic attempt stream. Pure no-DB unit
// (imports only the estimator lib + src/core/theta) → unit partition.
//
// Lands in scripts/**/*.test.ts → matched by fastTestInclude (unit) AND
// allTestInclude; fastTestInclude wins, so this runs no-DB. The DB-touching
// replay script (scripts/replay-urnings-lite.ts) is NOT imported here.

import { conjunctiveCredits, eloK, expectedScore, updateTheta } from '@/core/theta';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DENSITY_THRESHOLD,
  DEFAULT_REPLAY_CONFIG,
  type ReplayAttempt,
  VARIANT_META,
  brierScore,
  familyDensities,
  fixedUniforms,
  logLoss,
  mfiTopKRegret,
  mulberry32,
  replayEloPoint,
  replayEloPrecision,
  replayGlickoRd,
  replayUrnings,
  thetaVolatility,
  toBinaryOutcome,
} from './lib/urnings-replay-estimators';

// ─────────────────────────────────────────────────────────────────────────────
// A fixed synthetic stream for one knowledge node: a learner who starts shaky
// (two wrongs) then improves (four corrects). b = 0 (anchor at average difficulty).
// ─────────────────────────────────────────────────────────────────────────────

function makeStream(outcomes: Array<0 | 1>, b = 0): ReplayAttempt[] {
  return outcomes.map((outcome, i) => ({
    questionId: `q${i}`,
    knowledgeId: 'k:test',
    outcome,
    timestamp: 1000 + i,
    b,
    bSource: 'item_calibration' as const,
  }));
}

const STREAM: Array<0 | 1> = [0, 0, 1, 1, 1, 1];

describe('outcome mapping', () => {
  it('maps success→1, failure→0, partial→1 (mirrors production θ̂ update; Codex #5)', () => {
    // Production updateThetaForAttempt is fed `attemptOutcome === 'failure' ? 0 : 1`
    // (paper-submit.ts), so partial counts as SUCCESS evidence. The replay's whole
    // value is mirroring that θ UPDATE, so it must fold partial→1 (NOT →0). This is
    // distinct from Phase 5/6 family-calibration, which EXCLUDES partial — a different
    // (calibration-label) channel, not the θ update.
    expect(toBinaryOutcome('success')).toBe(1);
    expect(toBinaryOutcome('failure')).toBe(0);
    expect(toBinaryOutcome('partial')).toBe(1);
  });
});

describe('variant 1 — Elo/MLE point estimate REUSES production theta.ts', () => {
  it('reproduces the exact production updateTheta trajectory on a known sequence', () => {
    const attempts = makeStream(STREAM);
    const result = replayEloPoint(attempts);

    // Re-derive the expected trajectory using ONLY the production functions, the
    // same way the variant claims to. If the variant ever diverges from
    // src/core/theta.ts this fails — that's the "matches production on a known
    // sequence" pin the task requires.
    let theta = DEFAULT_REPLAY_CONFIG.thetaPrior;
    const expectedTraj: number[] = [];
    attempts.forEach((a, i) => {
      theta = updateTheta(theta, a.b, a.outcome, eloK(i));
      expectedTraj.push(theta);
    });

    expect(result.thetaTrajectory).toEqual(expectedTraj);
    expect(result.thetaFinal).toBe(expectedTraj[expectedTraj.length - 1]);
    expect(result.n).toBe(STREAM.length);
  });

  it('single-KC conjunctiveCredits equals the standard Elo residual (outcome−p)', () => {
    // The variant relies on this production identity. Assert it directly.
    const theta = 0.3;
    const b = -0.2;
    const p = expectedScore(theta, b);
    expect(conjunctiveCredits([theta], b, 1)[0]).toBeCloseTo(1 - p, 12);
    expect(conjunctiveCredits([theta], b, 0)[0]).toBeCloseTo(0 - p, 12);
  });

  it('θ̂ rises after corrects and falls after wrongs', () => {
    const result = replayEloPoint(makeStream(STREAM));
    // first two attempts are wrong → θ̂ goes negative; then four corrects pull up
    expect(result.thetaTrajectory[1]).toBeLessThan(0);
    expect(result.thetaFinal).toBeGreaterThan(result.thetaTrajectory[1]);
  });

  it('predictions are prequential (made before the update) — first uses the prior', () => {
    const result = replayEloPoint(makeStream(STREAM));
    // first prediction must be σ(prior − b) = σ(0) = 0.5
    expect(result.predictions[0].pHat).toBeCloseTo(0.5, 12);
    expect(result.predictions).toHaveLength(STREAM.length);
  });

  it('weak difficulty_proxy anchor down-weights the θ̂ move by DIFFICULTY_PROXY_WEIGHT (Codex #1)', () => {
    // Production updateThetaForAttempt scales the move by bWeight=0.3 when b is the
    // difficulty proxy (no calibrated item_calibration.b). The replay must match: a
    // proxy-anchored stream must move θ̂ exactly DIFFICULTY_PROXY_WEIGHT× per step vs
    // the same stream on a calibrated anchor (everything else identical).
    const proxy = makeStream(STREAM).map((a) => ({ ...a, bSource: 'difficulty_proxy' as const }));
    const calib = makeStream(STREAM); // bSource: 'item_calibration'
    const proxyRes = replayEloPoint(proxy);
    const calibRes = replayEloPoint(calib);
    // first step from θ=0,b=0: calib Δ = k·(outcome−0.5); proxy Δ = 0.3·that (exact).
    expect(proxyRes.thetaTrajectory[0]).toBeCloseTo(calibRes.thetaTrajectory[0] * 0.3, 12);
    expect(proxyRes.thetaTrajectory[0]).not.toBeCloseTo(calibRes.thetaTrajectory[0], 6);
    // a single-step proxy stream is EXACTLY the production updateTheta with weight=0.3.
    const oneStep = [{ ...proxy[2] }]; // a 'correct' attempt at b=0
    const expected = updateTheta(0, 0, 1, eloK(0), 0.3);
    expect(replayEloPoint(oneStep).thetaTrajectory[0]).toBeCloseTo(expected, 12);
  });
});

describe('variant 2 — Elo + theta_precision REUSES production Phase 2 math', () => {
  it('θ̂ trajectory is identical to variant 1 (same update; only adds uncertainty)', () => {
    const attempts = makeStream(STREAM);
    const v1 = replayEloPoint(attempts);
    const v2 = replayEloPrecision(attempts);
    expect(v2.thetaTrajectory).toEqual(v1.thetaTrajectory);
  });

  it('SE decreases monotonically as observations accumulate (precision grows)', () => {
    const v2 = replayEloPrecision(makeStream(STREAM));
    for (let i = 1; i < v2.seTrajectory.length; i += 1) {
      expect(v2.seTrajectory[i]).toBeLessThanOrEqual(v2.seTrajectory[i - 1] + 1e-12);
    }
    expect(v2.thetaSeFinal).toBeLessThan(1); // started at SE=1 (prior precision 1)
  });

  it('SE-shrunk first prediction is exactly 0.5 at the prior (max uncertainty pull)', () => {
    const v2 = replayEloPrecision(makeStream(STREAM));
    // θ=prior=0 so shrink is irrelevant at b=0; pHat = σ(0) = 0.5
    expect(v2.predictions[0].pHat).toBeCloseTo(0.5, 12);
  });

  it('SE-shrunk prediction shrinks the (θ−b) LOGIT, not θ alone — cold/far-b pulls toward 0.5 (Codex #6)', () => {
    // Codex #6: at cold-start (precision=prior=1, θ̂=0) against a FAR anchor b=2, the
    // old `θ*shrink` formula left b un-shrunk → still predicted σ(0·shrink − 2)=σ(−2)
    // ≈ 0.12. The fixed logit-shrink predicts σ(shrink·(θ−b)) = σ(0.5·(0−2)) = σ(−1)
    // ≈ 0.27 — pulled toward 0.5 because the estimate is uncertain. The point estimate
    // (variant 1) is unchanged and still predicts the raw σ(0−2)=σ(−2).
    const farB = makeStream(STREAM, 2); // b = 2 (far above the cold θ̂=0)
    const v2 = replayEloPrecision(farB);
    const v1 = replayEloPoint(farB);
    const shrink =
      DEFAULT_REPLAY_CONFIG.thetaPrecisionPrior / (DEFAULT_REPLAY_CONFIG.thetaPrecisionPrior + 1); // = 0.5 at prior precision 1
    expect(v2.predictions[0].pHat).toBeCloseTo(expectedScore(shrink * (0 - 2), 0), 12);
    // shrunk prediction is STRICTLY closer to 0.5 than the raw point prediction.
    expect(Math.abs(v2.predictions[0].pHat - 0.5)).toBeLessThan(
      Math.abs(v1.predictions[0].pHat - 0.5),
    );
    // variant 1 (point) is unchanged: raw σ(θ−b) = σ(−2).
    expect(v1.predictions[0].pHat).toBeCloseTo(expectedScore(0, 2), 12);
  });

  it('weak difficulty_proxy anchor down-weights BOTH the θ̂ move and the Fisher info (Codex #1)', () => {
    // Production accumulates precision with weight²·Fisher (same bWeight as the move).
    // A proxy-anchored stream must grow precision more slowly (weaker info) AND move θ̂
    // less than the same stream on a calibrated anchor.
    const proxy = makeStream(STREAM).map((a) => ({ ...a, bSource: 'difficulty_proxy' as const }));
    const calib = makeStream(STREAM);
    const proxyRes = replayEloPrecision(proxy);
    const calibRes = replayEloPrecision(calib);
    // proxy move is 0.3× the calibrated move on the first step (θ̂ down-weight).
    expect(proxyRes.thetaTrajectory[0]).toBeCloseTo(calibRes.thetaTrajectory[0] * 0.3, 12);
    // proxy SE stays HIGHER (less information accumulated → weight²=0.09× per step).
    expect(proxyRes.thetaSeFinal).toBeGreaterThan(calibRes.thetaSeFinal);
  });
});

describe('variant 3 — Glicko/RD-style (spike) bounds + RD behavior', () => {
  it('produces a θ̂ trajectory of the right length and finite values', () => {
    const v3 = replayGlickoRd(makeStream(STREAM));
    expect(v3.thetaTrajectory).toHaveLength(STREAM.length);
    for (const t of v3.thetaTrajectory) expect(Number.isFinite(t)).toBe(true);
  });

  it('RD shrinks from its prior as games are observed', () => {
    const v3 = replayGlickoRd(makeStream(STREAM));
    const priorRdLogit = DEFAULT_REPLAY_CONFIG.glickoRdPrior / (400 / Math.log(10));
    expect(v3.rdFinal).toBeLessThan(priorRdLogit);
    for (const rd of v3.rdTrajectory) expect(rd).toBeGreaterThan(0);
  });

  it('θ̂ moves up on corrects and down on wrongs', () => {
    const allCorrect = replayGlickoRd(makeStream([1, 1, 1, 1]));
    const allWrong = replayGlickoRd(makeStream([0, 0, 0, 0]));
    expect(allCorrect.thetaFinal).toBeGreaterThan(0);
    expect(allWrong.thetaFinal).toBeLessThan(0);
  });
});

describe('variant 4 — Urnings prototype (spike) urn bounds + MH update', () => {
  it('green-ball count stays within [0, N] at every step', () => {
    const n = DEFAULT_REPLAY_CONFIG.urningsUrnSize;
    // accept everything (uniform=0 < ratio always)
    const v4 = replayUrnings(makeStream(STREAM), fixedUniforms([0]));
    for (const g of v4.greenTrajectory) {
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(n);
    }
    expect(v4.urnSize).toBe(n);
  });

  it('θ̂ is finite (clamped off the 0/1 urn boundary) even at all-correct / all-wrong', () => {
    const v4hi = replayUrnings(makeStream([1, 1, 1, 1, 1, 1, 1, 1]), fixedUniforms([0]));
    const v4lo = replayUrnings(makeStream([0, 0, 0, 0, 0, 0, 0, 0]), fixedUniforms([0]));
    expect(Number.isFinite(v4hi.thetaFinal)).toBe(true);
    expect(Number.isFinite(v4lo.thetaFinal)).toBe(true);
    // many corrects push θ̂ up; many wrongs push it down
    expect(v4hi.thetaFinal).toBeGreaterThan(v4lo.thetaFinal);
  });

  it('rejecting every proposal (uniform=1) keeps the urn frozen at its init', () => {
    const v4 = replayUrnings(makeStream(STREAM), fixedUniforms([1]));
    const init = v4.greenTrajectory[0];
    for (const g of v4.greenTrajectory) expect(g).toBe(init);
  });

  it('mulberry32 is deterministic for a fixed seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('metrics — log loss / Brier correctness on known inputs', () => {
  it('log loss of a perfect confident prediction is ~0', () => {
    expect(logLoss([{ pHat: 1 - 1e-9, outcome: 1 }])).toBeCloseTo(0, 6);
    expect(logLoss([{ pHat: 1e-9, outcome: 0 }])).toBeCloseTo(0, 6);
  });

  it('log loss of a coin-flip prediction is ln(2)', () => {
    expect(logLoss([{ pHat: 0.5, outcome: 1 }])).toBeCloseTo(Math.LN2, 12);
    expect(logLoss([{ pHat: 0.5, outcome: 0 }])).toBeCloseTo(Math.LN2, 12);
  });

  it('Brier score of a coin-flip prediction is 0.25', () => {
    expect(brierScore([{ pHat: 0.5, outcome: 1 }])).toBeCloseTo(0.25, 12);
  });

  it('Brier score of a perfect prediction is 0', () => {
    expect(brierScore([{ pHat: 1, outcome: 1 }])).toBeCloseTo(0, 12);
    expect(brierScore([{ pHat: 0, outcome: 0 }])).toBeCloseTo(0, 12);
  });

  it('Brier averages over multiple predictions', () => {
    // 0.5 vs 1 → 0.25; 0.5 vs 0 → 0.25; mean 0.25
    expect(
      brierScore([
        { pHat: 0.5, outcome: 1 },
        { pHat: 0.5, outcome: 0 },
      ]),
    ).toBeCloseTo(0.25, 12);
  });

  it('empty predictions → NaN (honest, not a fabricated 0)', () => {
    expect(Number.isNaN(logLoss([]))).toBe(true);
    expect(Number.isNaN(brierScore([]))).toBe(true);
  });
});

describe('metrics — θ volatility', () => {
  it('a flat trajectory has zero volatility', () => {
    expect(thetaVolatility([0.5, 0.5, 0.5])).toBe(0);
  });

  it('volatility is the mean absolute step', () => {
    // steps: |1-0|=1, |0-1|=1 → mean 1
    expect(thetaVolatility([0, 1, 0])).toBeCloseTo(1, 12);
  });

  it('a single point (or empty) has zero volatility', () => {
    expect(thetaVolatility([0.7])).toBe(0);
    expect(thetaVolatility([])).toBe(0);
  });
});

describe('metrics — MFI top-k regret proxy', () => {
  const candidateBs = [-1, 0, 1];

  it('a trajectory identical to the reference has zero regret', () => {
    const traj = [-0.9, 0.1, 0.9];
    expect(mfiTopKRegret(traj, traj, candidateBs)).toBe(0);
  });

  it('a wobblier trajectory that flips MFI picks vs a stable reference has >0 regret', () => {
    const reference = [0.1, 0.1, 0.1]; // always picks b=0 (index 1)
    const wobbly = [0.1, 0.9, -0.9]; // picks 0, 1, -1 → 2 disagreements / 3
    expect(mfiTopKRegret(wobbly, reference, candidateBs)).toBeCloseTo(2 / 3, 12);
  });

  it('empty inputs → NaN', () => {
    expect(Number.isNaN(mfiTopKRegret([], [], candidateBs))).toBe(true);
    expect(Number.isNaN(mfiTopKRegret([0], [0], []))).toBe(true);
  });
});

describe('density gate — whether any verdict is even possible', () => {
  it('flags families below the threshold as not meeting density', () => {
    const byNode = new Map<string, ReplayAttempt[]>([
      ['k:dense', makeStream(new Array(35).fill(1) as Array<0 | 1>)],
      ['k:sparse', makeStream([1, 0, 1])],
    ]);
    const densities = familyDensities(byNode, DEFAULT_DENSITY_THRESHOLD);
    const dense = densities.find((d) => d.knowledgeId === 'k:dense');
    const sparse = densities.find((d) => d.knowledgeId === 'k:sparse');
    expect(dense?.meetsThreshold).toBe(true);
    expect(dense?.observations).toBe(35);
    expect(sparse?.meetsThreshold).toBe(false);
    expect(sparse?.observations).toBe(3);
  });

  it('sorts densest families first', () => {
    const byNode = new Map<string, ReplayAttempt[]>([
      ['k:a', makeStream([1, 0])],
      ['k:b', makeStream([1, 0, 1, 1])],
    ]);
    const densities = familyDensities(byNode, DEFAULT_DENSITY_THRESHOLD);
    expect(densities[0].knowledgeId).toBe('k:b');
  });
});

describe('variant metadata — production-reuse vs spike honesty', () => {
  it('marks variant 1 & 2 as production reuse, 3 & 4 as documented spikes', () => {
    expect(VARIANT_META.elo_point.reusesProductionMath).toBe(true);
    expect(VARIANT_META.elo_precision.reusesProductionMath).toBe(true);
    expect(VARIANT_META.glicko_rd.reusesProductionMath).toBe(false);
    expect(VARIANT_META.urnings.reusesProductionMath).toBe(false);
    // spikes MUST document their simplification
    expect(VARIANT_META.glicko_rd.simplification.length).toBeGreaterThan(0);
    expect(VARIANT_META.urnings.simplification.length).toBeGreaterThan(0);
  });

  it('production-reuse variants HONESTLY document the per-node multi-KC simplification (Codex #2)', () => {
    // Codex #2 decision = DOCUMENT (joint multi-KC replay needs a per-event
    // architecture rewrite, disproportionate to a data-gated spike). The reuse claim
    // stays `true` (production-EXACT for single-KC questions, which production also
    // degenerates to standard Elo on), but the per-node single-KC stream IS a
    // documented simplification of the joint multi-KC credit — the simplification
    // field must say so, so the "production reuse" claim is qualified, not false.
    expect(VARIANT_META.elo_point.simplification).toMatch(/single-KC|multi-KC|joint/);
    expect(VARIANT_META.elo_precision.simplification).toMatch(/single-KC|multi-KC|joint/);
  });
});
