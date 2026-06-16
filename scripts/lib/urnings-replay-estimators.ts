// YUK-361 Phase 7 (Task 12) — Offline Urnings replay spike: pure θ-estimation
// variants + metrics. ANALYSIS-ONLY tooling — NOT a production code path.
//
// Why this file lives in scripts/lib/ (not src/): these estimators are an offline
// model-comparison harness for a DEFERRED decision (ADR-0042 verdict = Elo over
// Urnings ONLINE; this offline gate is the deferred re-examination per the
// urnings-lite amendment). Variants 3 & 4 are SPIKE implementations and must NOT
// leak into production src/ paths. Variants 1 & 2 REUSE the real production math
// from src/core/theta.ts (read-only import) so the comparison's baseline IS the
// production behavior, not a re-impl.
//
// Pure + deterministic: no DB, no IO, no randomness in the estimator updates
// (the Urnings urn update is made deterministic via an injectable uniform — the
// replay script feeds a seeded PRNG; the unit test feeds a fixed sequence). This
// is where correctness is pinned, because real attempt data is sparse (n=1 stack).
// ─────────────────────────────────────────────────────────────────────────────

import {
  conjunctiveCredits,
  eloK,
  expectedScore,
  thetaSe,
  updateTheta,
  updateThetaPrecision,
} from '@/core/theta';

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

/** One historical attempt, already resolved to a single knowledge node. */
export interface ReplayAttempt {
  /** stable question id (event.subject_id) */
  questionId: string;
  /** the knowledge node this replay row is attributed to */
  knowledgeId: string;
  /** 0 = wrong, 1 = correct (partial is mapped by the caller; see toBinaryOutcome) */
  outcome: 0 | 1;
  /** ms epoch of the attempt (event.created_at) — used only for ordering */
  timestamp: number;
  /**
   * the item difficulty anchor (logit scale) in effect at attempt time.
   * effectiveB(item_calibration) when present, else difficultyToLogitB(question.difficulty).
   * null = no anchor resolvable → the caller skips the row (cannot score it).
   */
  b: number;
  /** where b came from — for honest reporting of anchor quality */
  bSource: 'item_calibration' | 'difficulty_proxy';
}

/** A single prediction made BEFORE seeing the outcome (for predictive metrics). */
export interface Prediction {
  /** P(correct) the variant assigned before observing this attempt's outcome */
  pHat: number;
  /** the realized outcome (0/1) */
  outcome: 0 | 1;
}

/** Per-variant replay result for one knowledge node. */
export interface VariantNodeResult {
  knowledgeId: string;
  /** θ̂ after each attempt, in attempt order (length === attempts) */
  thetaTrajectory: number[];
  /** the prequential predictions (one per attempt; the first uses the prior) */
  predictions: Prediction[];
  /** final θ̂ */
  thetaFinal: number;
  /** number of attempts replayed for this node */
  n: number;
}

export type VariantId = 'elo_point' | 'elo_precision' | 'glicko_rd' | 'urnings';

export interface VariantMeta {
  id: VariantId;
  label: string;
  /** true = REUSES production math from src/core/theta.ts; false = spike impl */
  reusesProductionMath: boolean;
  /** documented simplification vs the canonical model (empty for production reuse) */
  simplification: string;
}

export const VARIANT_META: Record<VariantId, VariantMeta> = {
  elo_point: {
    id: 'elo_point',
    label: 'Elo/MLE point estimate (production)',
    reusesProductionMath: true,
    simplification: '',
  },
  elo_precision: {
    id: 'elo_precision',
    label: 'Elo/MLE + theta_precision (production Phase 2)',
    reusesProductionMath: true,
    simplification: '',
  },
  glicko_rd: {
    id: 'glicko_rd',
    label: 'Glicko/RD-style uncertainty (spike)',
    reusesProductionMath: false,
    simplification:
      'Glicko-2-ish single-game-per-rating-period against the FIXED item difficulty b ' +
      'as a zero-RD opponent (b is read-only anchor, never updated — mirrors the G4 ' +
      'item-half lock). RD pre-inflation uses a fixed c per attempt rather than ' +
      'elapsed-time; volatility σ is held constant (no Step-5 σ′ iteration). On the ' +
      'natural-log/glicko-400 scale internally, exported θ̂ is rescaled to the logit ' +
      'scale used by the other variants for comparable predictions.',
  },
  urnings: {
    id: 'urnings',
    label: 'Full Urnings prototype (spike)',
    reusesProductionMath: false,
    simplification:
      'Binomial player urn of size N (default 16); the item half is NOT co-estimated ' +
      '(b held as a fixed anchor → its urn fraction is derived from b, never updated), ' +
      'so this is the SAFE half of Urnings only (matches ADR-0042 amendment: online ' +
      'item-half co-estimation is unsafe at n=1). Propose a ±1 green-ball move toward the ' +
      'observation, accept via a SINGLE-OBSERVATION LIKELIHOOD-RATIO (min(1, L(prop)/L(cur))) ' +
      "— NOT the paper's full Metropolis-Hastings chain (proposal density + Beta-binomial " +
      'prior terms omitted), so the stationary distribution is approximate, not exactly ' +
      'Beta-binomial. A reasonable-but-non-canonical urn estimator (a weaker urn only makes ' +
      'urnings less likely to "win", biasing toward the conservative default). ' +
      'θ̂ = logit(greenBalls / N), clamped off the 0/1 boundary. ' +
      'Adaptive-selection correction (O(|items|) reweighting) is OMITTED — this replay ' +
      'is offline over a fixed historical stream, not an adaptive selector.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Config (shared priors so the variants are compared on equal footing)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayConfig {
  /** cold-start prior for θ̂ (logit). 0 = "average ability" under 1PL. */
  thetaPrior: number;
  /** prior precision for variant 2 (matches production default = 1 unit, SE=1). */
  thetaPrecisionPrior: number;
  /** Glicko prior RD on the glicko-400 scale (Glicko-2 default 350). */
  glickoRdPrior: number;
  /** Glicko fixed volatility σ (Glicko-2 default 0.06). */
  glickoVolatility: number;
  /** Glicko per-attempt RD inflation constant c (glicko-400 scale). */
  glickoC: number;
  /** Urnings player-urn size N. Larger = finer θ̂ resolution, slower mixing. */
  urningsUrnSize: number;
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  thetaPrior: 0,
  thetaPrecisionPrior: 1,
  glickoRdPrior: 350,
  glickoVolatility: 0.06,
  glickoC: 34.6, // ≈ 350/√(100) so RD decays to prior over ~100 idle periods
  urningsUrnSize: 16,
};

const GLICKO_SCALE = 400 / Math.log(10); // glicko-400 ↔ natural-log (Glicko-2 q)

/** Map the 3-way event outcome to a binary 0/1; partial → 0.5-rounded to the caller's policy. */
export function toBinaryOutcome(outcome: 'success' | 'failure' | 'partial'): 0 | 1 {
  // Spike policy: partial counts as failure (conservative; objective items rarely
  // produce partial). The script logs how many partials were folded this way.
  return outcome === 'success' ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant 1 — Elo/MLE point estimate (PRODUCTION reuse)
//
// Replays the EXACT production online update: per attempt, θ̂' = θ̂ + K·credit,
// where credit = conjunctiveCredits([θ̂], b, outcome)[0] (single-KC → standard Elo
// residual outcome−p) and K = eloK(evidenceCount). b is the read-only anchor.
// ─────────────────────────────────────────────────────────────────────────────

export function replayEloPoint(
  attempts: ReplayAttempt[],
  cfg: ReplayConfig = DEFAULT_REPLAY_CONFIG,
): VariantNodeResult {
  let theta = cfg.thetaPrior;
  const thetaTrajectory: number[] = [];
  const predictions: Prediction[] = [];
  attempts.forEach((a, i) => {
    const pHat = expectedScore(theta, a.b); // predict BEFORE update (prequential)
    predictions.push({ pHat, outcome: a.outcome });
    const credit = conjunctiveCredits([theta], a.b, a.outcome)[0]; // single-KC Elo residual
    const k = eloK(i); // evidenceCount = attempts seen so far for this node
    theta = updateTheta(theta, a.b, a.outcome, k); // outcome−expected internally; credit asserted in tests
    thetaTrajectory.push(theta);
    void credit; // credit kept for parity assertion in tests (== outcome−p at n=1)
  });
  return {
    knowledgeId: attempts[0]?.knowledgeId ?? '',
    thetaTrajectory,
    predictions,
    thetaFinal: theta,
    n: attempts.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant 2 — Elo/MLE + theta_precision (PRODUCTION reuse, Phase 2)
//
// Same θ̂ trajectory as variant 1, PLUS Fisher-info precision accumulation
// (updateThetaPrecision / thetaSe from src/core/theta.ts). The uncertainty is
// surfaced two ways: (a) the SE trajectory (for the MFI-instability proxy), and
// (b) an SE-shrunk prediction — when θ̂ is uncertain (high SE) the prediction is
// pulled toward 0.5, the standard uncertainty-aware-down-weighting MFI uses.
// ─────────────────────────────────────────────────────────────────────────────

export interface PrecisionNodeResult extends VariantNodeResult {
  /** θ̂ standard error after each attempt (SE = 1/√precision). */
  seTrajectory: number[];
  thetaSeFinal: number;
}

export function replayEloPrecision(
  attempts: ReplayAttempt[],
  cfg: ReplayConfig = DEFAULT_REPLAY_CONFIG,
): PrecisionNodeResult {
  let theta = cfg.thetaPrior;
  let precision = cfg.thetaPrecisionPrior;
  const thetaTrajectory: number[] = [];
  const seTrajectory: number[] = [];
  const predictions: Prediction[] = [];
  attempts.forEach((a, i) => {
    const se = thetaSe(precision);
    // SE-shrunk prediction: scale the (θ−b) logit by precision/(precision+1) so
    // a cold/uncertain θ̂ predicts closer to 0.5. precision→∞ recovers the raw
    // Elo prediction (variant 1). This is the predictive expression of the same
    // uncertainty MFI uses to down-weight uncertain θ̂.
    const shrink = precision / (precision + 1);
    const pHat = expectedScore(theta * shrink + cfg.thetaPrior * (1 - shrink), a.b);
    predictions.push({ pHat, outcome: a.outcome });
    // accumulate precision at θ̂ BEFORE the move (information evaluated where the
    // gradient is taken — matches production updateThetaPrecision contract)
    precision = updateThetaPrecision(precision, theta, a.b);
    const k = eloK(i);
    theta = updateTheta(theta, a.b, a.outcome, k);
    thetaTrajectory.push(theta);
    seTrajectory.push(thetaSe(precision));
    void se;
  });
  return {
    knowledgeId: attempts[0]?.knowledgeId ?? '',
    thetaTrajectory,
    seTrajectory,
    predictions,
    thetaFinal: theta,
    thetaSeFinal: thetaSe(precision),
    n: attempts.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant 3 — Glicko/RD-style (SPIKE impl)
//
// Minimal Glicko-2-ish update. Each attempt is one game against the item, treated
// as a zero-RD opponent at difficulty b (b is read-only — the item half is never
// updated, mirroring G4). Internally on the glicko-400 scale; θ̂ is converted to
// the logit scale on export so predictions are comparable to the Elo variants.
//
// Simplifications (documented in VARIANT_META.glicko_rd):
//  - one game per rating period (no batching)
//  - RD pre-inflation uses a fixed per-attempt c (not elapsed time)
//  - volatility σ held constant (no Step-5 σ′ iteration)
// ─────────────────────────────────────────────────────────────────────────────

export interface GlickoNodeResult extends VariantNodeResult {
  /** rating deviation (logit scale) after each attempt — the RD-style uncertainty. */
  rdTrajectory: number[];
  rdFinal: number;
}

function gFactor(rdLogit: number): number {
  return 1 / Math.sqrt(1 + (3 * rdLogit * rdLogit) / (Math.PI * Math.PI));
}

export function replayGlickoRd(
  attempts: ReplayAttempt[],
  cfg: ReplayConfig = DEFAULT_REPLAY_CONFIG,
): GlickoNodeResult {
  // θ on the logit scale internally too (so b lines up); RD converted from the
  // glicko-400 prior to logit.
  let theta = cfg.thetaPrior;
  let rd = cfg.glickoRdPrior / GLICKO_SCALE; // logit-scale RD
  const cLogit = cfg.glickoC / GLICKO_SCALE;
  const thetaTrajectory: number[] = [];
  const rdTrajectory: number[] = [];
  const predictions: Prediction[] = [];

  for (const a of attempts) {
    // Step: pre-inflate RD for the elapsed period (fixed c)
    rd = Math.sqrt(rd * rd + cLogit * cLogit);
    // opponent = item at difficulty b, RD_opp = 0 → g(0)=1, but we still use the
    // PLAYER's g for the variance term per Glicko-2.
    const g = gFactor(0); // opponent RD = 0 (anchor)
    const e = 1 / (1 + Math.exp(-g * (theta - a.b))); // expected score
    const pHat = e; // prediction BEFORE update
    predictions.push({ pHat, outcome: a.outcome });
    // estimated variance v from this single game (used for the RD update below).
    // NOTE: full Glicko-2's Step-5 σ′-volatility iteration + the Δ improvement term are
    // OMITTED (σ held constant, per VARIANT_META.glicko_rd) — the rating step below is the
    // standard μ' = μ + φ'²·g·(s−E) with φ'=newRd absorbing v, no Δ scaffolding needed.
    const v = 1 / (g * g * e * (1 - e) || 1e-9);
    // new RD and rating (σ held constant: φ* = √(φ²+σ²) before combining with v)
    const phiStar = Math.sqrt(rd * rd + cfg.glickoVolatility * cfg.glickoVolatility);
    const newRd = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
    theta = theta + newRd * newRd * g * (a.outcome - e);
    rd = newRd;
    thetaTrajectory.push(theta);
    rdTrajectory.push(rd);
  }

  return {
    knowledgeId: attempts[0]?.knowledgeId ?? '',
    thetaTrajectory,
    rdTrajectory,
    predictions,
    thetaFinal: theta,
    rdFinal: rd,
    n: attempts.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant 4 — Full Urnings prototype (SPIKE impl)
//
// Minimal binomial-urn estimator (Bolsinova et al. Urnings, the player half only).
// Player urn = N balls, `green` of which are "success" balls; π = green/N is the
// urn's success-probability estimate, θ̂ = logit(π) (clamped). The item half is a
// FIXED anchor: its urn fraction is derived from b (π_item = σ(−b)) and never
// updated — the safe half (ADR-0042 amendment: online item co-estimation unsafe).
//
// Core paper update per observation:
//   1. simulate a pseudo-outcome from the current urns (the "game")
//   2. propose green' = green ± 1 toward the observed outcome
//   3. accept via the Metropolis-Hastings ratio so the stationary distribution is
//      the Beta-binomial posterior around the true success probability.
// The uniform draw for the MH accept is INJECTED (deterministic in tests / seeded
// in the script) — the update math itself is pure given that draw.
// ─────────────────────────────────────────────────────────────────────────────

export interface UrningsNodeResult extends VariantNodeResult {
  /** green-ball count after each attempt (0..N) — the urn state. */
  greenTrajectory: number[];
  greenFinal: number;
  urnSize: number;
}

/** A uniform draw source in [0,1). Injected so the urn update is deterministic. */
export type UniformSource = () => number;

/** Deterministic uniform source from a fixed list (cycles); for tests. */
export function fixedUniforms(values: number[]): UniformSource {
  let i = 0;
  return () => {
    const v = values[i % values.length] ?? 0;
    i += 1;
    return v;
  };
}

/** Mulberry32 — tiny seeded PRNG for the replay script (deterministic per run). */
export function mulberry32(seed: number): UniformSource {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const URN_EPS = 0.5; // half-ball clamp so π ∈ (0,1) → θ̂ finite

function urnTheta(green: number, n: number): number {
  const pi = Math.min(n - URN_EPS, Math.max(URN_EPS, green)) / n;
  return Math.log(pi / (1 - pi));
}

export function replayUrnings(
  attempts: ReplayAttempt[],
  uniform: UniformSource,
  cfg: ReplayConfig = DEFAULT_REPLAY_CONFIG,
): UrningsNodeResult {
  const n = cfg.urningsUrnSize;
  // initialise green from the θ prior: green0 = round(N·σ(thetaPrior))
  let green = Math.round(n * expectedScore(cfg.thetaPrior, 0));
  green = Math.min(n, Math.max(0, green));
  const thetaTrajectory: number[] = [];
  const greenTrajectory: number[] = [];
  const predictions: Prediction[] = [];

  for (const a of attempts) {
    const theta = urnTheta(green, n);
    const pHat = expectedScore(theta, a.b);
    predictions.push({ pHat, outcome: a.outcome });

    // Propose a move toward the observed outcome (the paper's simulate-then-swap,
    // simplified to a ±1 proposal biased by the observation):
    //   correct → propose adding a green ball; wrong → propose removing one.
    const proposed = a.outcome === 1 ? Math.min(n, green + 1) : Math.max(0, green - 1);
    if (proposed === green) {
      // already at a boundary; no move possible
      thetaTrajectory.push(theta);
      greenTrajectory.push(green);
      continue;
    }
    // Single-observation LIKELIHOOD-RATIO accept (NOT the paper's full Metropolis-Hastings
    // chain): accept the ±1 proposal with prob min(1, L(prop)/L(cur)) where L is the
    // likelihood of THIS one outcome under each candidate urn (σ(θ−b)). This omits the
    // proposal density + Beta-binomial prior terms, so the stationary distribution is NOT
    // exactly Beta-binomial — it's a reasonable-but-non-canonical urn estimator. Acceptable
    // for an offline spike whose verdict is data-gated; a weaker-than-canonical urn only
    // makes urnings LESS likely to "win", biasing toward the conservative Elo+precision default.
    const pCur = expectedScore(theta, a.b);
    const pProp = expectedScore(urnTheta(proposed, n), a.b);
    // likelihood of THIS observation under each candidate urn:
    const likCur = a.outcome === 1 ? pCur : 1 - pCur;
    const likProp = a.outcome === 1 ? pProp : 1 - pProp;
    const ratio = likCur > 0 ? Math.min(1, likProp / likCur) : 1;
    if (uniform() < ratio) {
      green = proposed;
    }
    thetaTrajectory.push(urnTheta(green, n));
    greenTrajectory.push(green);
  }

  return {
    knowledgeId: attempts[0]?.knowledgeId ?? '',
    thetaTrajectory,
    greenTrajectory,
    predictions,
    thetaFinal: urnTheta(green, n),
    greenFinal: green,
    urnSize: n,
    n: attempts.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics (Task 12 step 3) — all pure over the prequential predictions / trajectory.
// ─────────────────────────────────────────────────────────────────────────────

/** Mean next-answer log loss (a.k.a. cross-entropy) over prequential predictions. */
export function logLoss(predictions: Prediction[]): number {
  if (predictions.length === 0) return Number.NaN;
  const eps = 1e-12;
  const sum = predictions.reduce((acc, { pHat, outcome }) => {
    const p = Math.min(1 - eps, Math.max(eps, pHat));
    return acc - (outcome === 1 ? Math.log(p) : Math.log(1 - p));
  }, 0);
  return sum / predictions.length;
}

/** Mean Brier score (squared error of the probabilistic prediction). */
export function brierScore(predictions: Prediction[]): number {
  if (predictions.length === 0) return Number.NaN;
  const sum = predictions.reduce((acc, { pHat, outcome }) => {
    const d = pHat - outcome;
    return acc + d * d;
  }, 0);
  return sum / predictions.length;
}

/**
 * θ volatility — instability of θ̂ over the stream = mean absolute step between
 * consecutive θ̂. Lower = more stable. (n<2 → 0; nothing to step.)
 */
export function thetaVolatility(thetaTrajectory: number[]): number {
  if (thetaTrajectory.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < thetaTrajectory.length; i += 1) {
    sum += Math.abs(thetaTrajectory[i] - thetaTrajectory[i - 1]);
  }
  return sum / (thetaTrajectory.length - 1);
}

/**
 * MFI top-k regret proxy — how often the variant's MFI-selected item differs from
 * the best-informative item under a reference θ̂.
 *
 * MFI selects argmax_q Fisher-info I(θ̂, b_q) = argmin_q |θ̂ − b_q| (1PL: info peaks
 * at b=θ). We compare each variant's pick against the reference variant's pick over
 * a fixed candidate item pool, at each step of the stream. Returns the fraction of
 * steps where the picks differ (0 = always agrees with reference; 1 = never agrees).
 *
 * This is a *proxy* for MFI instability: a θ̂ that wobbles will keep changing which
 * item is "most informative", churning the selection. We measure that churn as the
 * disagreement rate vs a stable reference (the production Elo-precision variant).
 */
export function mfiTopKRegret(
  variantThetaTrajectory: number[],
  referenceThetaTrajectory: number[],
  candidateBs: number[],
): number {
  const steps = Math.min(variantThetaTrajectory.length, referenceThetaTrajectory.length);
  if (steps === 0 || candidateBs.length === 0) return Number.NaN;
  let disagreements = 0;
  for (let i = 0; i < steps; i += 1) {
    const pickV = argMinAbsDiff(variantThetaTrajectory[i], candidateBs);
    const pickR = argMinAbsDiff(referenceThetaTrajectory[i], candidateBs);
    if (pickV !== pickR) disagreements += 1;
  }
  return disagreements / steps;
}

/** index of the candidate b closest to θ (MFI peak at b=θ under 1PL). */
function argMinAbsDiff(theta: number, candidateBs: number[]): number {
  let best = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  candidateBs.forEach((b, i) => {
    const d = Math.abs(theta - b);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  });
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Density gate (Task 12 step 3 last bullet) — whether ANY verdict is even possible.
// ─────────────────────────────────────────────────────────────────────────────

export interface FamilyDensity {
  knowledgeId: string;
  /** objective repeated observations (binary-outcome attempts) for this family. */
  observations: number;
  meetsThreshold: boolean;
}

/**
 * A family meets the density threshold when it has ≥ minObservations repeated
 * OBJECTIVE observations. This gates whether the model comparison can produce a
 * verdict at all — sparse families make any log-loss/Brier difference noise.
 */
export function familyDensities(
  attemptsByNode: Map<string, ReplayAttempt[]>,
  minObservations: number,
): FamilyDensity[] {
  return [...attemptsByNode.entries()]
    .map(([knowledgeId, attempts]) => ({
      knowledgeId,
      observations: attempts.length,
      meetsThreshold: attempts.length >= minObservations,
    }))
    .sort((a, b) => b.observations - a.observations);
}

/** Default density threshold: a family needs this many objective observations
 *  before its model-comparison signal is trusted for a verdict. 30 is a
 *  deliberately conservative floor (per-family CI on a log-loss delta at n<30 is
 *  wider than any plausible Elo-vs-Urnings gap). Tunable in the script. */
export const DEFAULT_DENSITY_THRESHOLD = 30;
