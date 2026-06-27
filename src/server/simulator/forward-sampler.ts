// A14/A15 simulator infrastructure (YUK-446 / YUK-447) — synthetic-learner FORWARD SAMPLER.
//
// WHAT THIS IS: a pure, seeded, deterministic generator of synthetic learner answer
//   sequences. Given (latent ability θ*, item difficulty b, KC structure incl. prereq
//   edges) it samples an ordered outcome trajectory by REUSING the exact same probability
//   primitives the LIVE engine uses — the 1PL/Rasch ICC `expectedScore` (a≡1), the PFA
//   logistic `pfaLogit`/`pLearned`, and the SRT continuous outcome `srtOutcome`. It is the
//   training GROUND for the two non-myopic / open-elicitation methods:
//     - A14 DAD (YUK-446): a policy net optimising the WHOLE remaining sequence's total
//       information gain is trained by ROLLING OUT over MANY simulated learners (the
//       amortised-over-simulation reframe — train on synthetic data, deploy on n=1).
//     - A15 adaptive elicitation (YUK-447): the PFN / in-context Bayes elicitation policy
//       likewise needs a learner SIMULATOR to meta-train against before n=1 deployment.
//
// WHAT THIS IS NOT (scope fence — owner decision, Wave2 2026-06-27):
//   - NO policy network / training loop (that is a `scripts/` offline harness, later).
//   - NO `open_diagnostic_log` table (owner left the "new table vs reuse `event` stream"
//     question UNSIGNED — this lane builds ZERO tables, ZERO migrations, ZERO 5-surface
//     registration).
//   - NO LIVE wiring: this module is never imported by a route / job / selection path. It
//     touches no DB, no flag, no live engine. It is a pure offline asset.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// ⚠ SIMULATOR-MISSPECIFICATION — THE HONEST CIRCULARITY (read before trusting any rollout)
// ─────────────────────────────────────────────────────────────────────────────────────
// A policy trained against this sampler is ONLY as good as the assumption that the real
// learner obeys the SAME generative form (conjunctive 1PL ability + PFA practice accrual +
// KG prereq gating) that this sampler emits. Because the sampler and the live ESTIMATOR
// share functional family, a policy can look perfect in-simulation while optimising the
// WRONG information on a learner whose true process differs. Near-zero in-sim regret is
// therefore NOT evidence of real-world performance.
//   - This is the `simulator-misspecification` failure class. It is DISTINCT from the
//     `prior-misspecification` class of A12/A13 (a wrong PRIOR over a correct model, vs.
//     here a wrong MODEL family). Both issues name this explicitly as their failure mode.
//   - GUARD: before any DAD/elicitation policy is trusted, it must clear an explicit
//     misspecification check (e.g. robustness across a FAMILY of perturbed sampler configs,
//     and a held-out retro-validation à la `audit:calibration` V-A1-fwd forward-AUC replay).
//     That gate lives DOWNSTREAM of this lane; this module only provides the generator.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// n=1 ADMISSIBILITY (litmus) — every generative parameter here is admissible because it is
// an OWNER-FIXED PRIOR or the SYNTHETIC learner's OWN accumulated state. The sampler MUST
// stay inside the live engine's admissible model family:
//   - Ability is Rasch/1PL (a ≡ 1). There is NO per-item discrimination `a`, NO slip, NO
//     guess, NO time-discrimination. Those are cross-examinee variance parameters and are
//     INADMISSIBLE — do NOT add them to enrich training. Item difficulty `b` is a locked
//     anchor (zero cross-examinee variance), exactly as in the live Elo/θ̂ path.
//   - PFA learning-rate (γ/ρ) and the KG prereq penalty / mastery threshold are OWNER-
//     SUPPLIED design constants (fixed priors), NOT fitted per-learner parameters.
//   - The RT model is the simplest admissible choice (uniform fraction of the item time-
//     limit d, where d = the owner-fixed SRT design constant). A richer RT model would risk
//     smuggling a per-examinee time-discrimination parameter — deliberately NOT done.
// Consequence: a policy's INFERENCE-time inputs (the synthetic learner's own belief state /
// answer history) are admissible; the only n=1 risk lives in the misspecification note above.

import { PFA_GAMMA, PFA_RHO, pLearned, pfaLogit } from '@/core/pfa';
import {
  conjunctiveCredits,
  conjunctiveCreditsContinuous,
  eloK,
  expectedScore,
  resolveSrtTimeLimit,
  srtOutcome,
  thetaSe,
  updateThetaPrecision,
} from '@/core/theta';
import { mulberry32 } from '@/server/calibration/rng';

// ── Scenario types ───────────────────────────────────────────────────────────────────

/** A knowledge component in the synthetic learner's world. */
export interface SimKc {
  /** Stable KC id (referenced by items + prereq edges). */
  id: string;
  /**
   * Latent TRUE ability on this KC (logit). Owner-supplied scenario input — the
   * ground-truth a policy is ultimately trying to assess / exploit. In PFA mode this seeds
   * the practice accrual; in IRT mode it is the static ability.
   */
  trueTheta: number;
  /**
   * PFA difficulty intercept for this KC (logit). Owner-fixed; defaults to 0 (neutral). In
   * PFA mode, if absent the item's `b` is used as the difficulty anchor (mirrors the live
   * "KC representative item difficulty as β" convention in core/pfa.ts).
   */
  beta?: number;
  /** KG prerequisite KC ids. Unmet prereqs depress effective ability (see prereqPenalty). */
  prereqIds?: string[];
}

/** A single answerable item. 1PL/Rasch family: difficulty `b` only, a ≡ 1. */
export interface SimItem {
  id: string;
  /** Locked difficulty anchor (logit). Zero cross-examinee variance — NOT fitted. */
  b: number;
  /** KCs this item taxes (conjunctive / DINA: all required → correct). Non-empty. */
  kcIds: string[];
  /** 1-5 ordinal difficulty, ONLY used to resolve the SRT design constant d. Optional. */
  difficulty?: number;
}

/** The generative model selecting how P(correct) is produced. */
export type ResponseModel =
  /** Static measurement sim: P = conjunctive σ(trueTheta_k − b). Ability does NOT change. */
  | 'irt'
  /** Learning sim: P from PFA p(L) over the learner's OWN accruing success/fail counts. */
  | 'pfa';

export interface SimScenario {
  kcs: SimKc[];
  items: SimItem[];
  /** Which generative form produces outcomes. Default 'irt'. */
  responseModel?: ResponseModel;
  /** PFA success learning-rate (owner-fixed). Default {@link PFA_GAMMA}. */
  pfaGamma?: number;
  /** PFA fail learning-rate (owner-fixed, negative). Default {@link PFA_RHO}. */
  pfaRho?: number;
  /**
   * Logit ability penalty per UNMET prerequisite (KG forward model). Owner-fixed design
   * constant. Default 0 → KG structure is INERT unless the owner opts in. > 0 means an
   * item taxing a KC whose prereqs the learner has not yet "mastered" is answered as if
   * the learner were weaker on that KC.
   */
  prereqPenalty?: number;
  /**
   * Generative "competence" threshold (probability) above which a KC counts as mastered
   * for prereq gating. Default 0.5 (the cold-start neutral point). Owner-fixed.
   */
  masteryThreshold?: number;
}

// ── Rollout options + records ──────────────────────────────────────────────────────────

/** Per-KC belief the ESTIMATOR holds — what a DAD/elicitation policy conditions on. */
export interface KcBelief {
  /** Online Elo θ̂ estimate (logit). Updated via the LIVE conjunctiveCredits + eloK path. */
  thetaHat: number;
  /** θ̂ standard error from accumulated Fisher precision (live thetaSe). */
  se: number;
  /** PFA p(L) point estimate from the ESTIMATOR's observed success/fail (live pLearned). */
  pLearned: number;
  /** Attempts the estimator has scored on this KC. */
  attempts: number;
}

/** One sampled step of the trajectory. */
export interface RolloutStep {
  /** 0-based position in the trajectory. */
  index: number;
  /** Index into scenario.items of the presented item. */
  itemIndex: number;
  itemId: string;
  /** TRUE conjunctive P(correct) under the generative model at presentation time. */
  pCorrect: number;
  /** Sampled binary outcome (1 correct / 0 wrong). */
  outcome: 0 | 1;
  /** Response time in seconds, if RT sampling enabled; else null. */
  responseTimeSec: number | null;
  /** The SRT continuous outcome-analog used for the estimator credit when RT present. */
  srtOutcome: number | null;
  /** Snapshot of the estimator belief for each KC the item taxed, AFTER this step. */
  beliefAfter: Record<string, KcBelief>;
}

export interface RolloutResult {
  steps: RolloutStep[];
  /** Final estimator belief per KC. */
  finalBelief: Record<string, KcBelief>;
  /**
   * Final GENERATIVE (ground-truth) competence per KC = the probability the TRUE model
   * would assign at neutral difficulty. For audit/diagnostics — this is the latent a
   * policy is chasing, never visible to the policy at inference.
   */
  trueCompetence: Record<string, number>;
}

/**
 * Item-selection policy seam — THIS is where the A14 DAD policy net or the A15 elicitation
 * policy plugs in. Given the current belief state + history + a (policy-private) rng draw,
 * return the index of the next item to present, or null to stop early.
 *
 * The default policy ({@link roundRobinPolicy}) is a trivial deterministic baseline so the
 * sampler is self-contained and testable WITHOUT a trained policy.
 */
export type SelectionPolicy = (ctx: PolicyContext) => number | null;

export interface PolicyContext {
  /** 0-based step about to be produced. */
  step: number;
  /** Total budget (max steps). */
  horizon: number;
  /** The item bank. */
  items: SimItem[];
  /** Current estimator belief per KC (before this step). */
  belief: Record<string, KcBelief>;
  /** Steps produced so far. */
  history: RolloutStep[];
  /** A policy-private uniform draw in [0,1) for stochastic policies (advances the stream). */
  draw: number;
}

export interface RolloutOptions {
  /** Number of items to present (budget). Required, must be ≥ 0. */
  horizon: number;
  /** Item-selection policy. Default {@link roundRobinPolicy}. */
  policy?: SelectionPolicy;
  /** Sample a response time per step (exercises the SRT continuous path). Default false. */
  sampleResponseTime?: boolean;
}

// ── Internal generative + estimator state ──────────────────────────────────────────────

interface DgpKcState {
  kc: SimKc;
  /** PFA-mode practice accrual (the synthetic learner's OWN history). */
  dgpSuccess: number;
  dgpFail: number;
}

interface EstKcState {
  thetaHat: number;
  thetaPrecision: number;
  estSuccess: number;
  estFail: number;
  attempts: number;
}

/**
 * Map lookup that throws (instead of a non-null assertion) when a key is missing. Every
 * call site here looks up a KC id that {@link assertValidScenario} has already proven to
 * exist in the state maps, so a miss is an internal invariant break — fail LOUD.
 */
function mustGet<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`forward-sampler: internal state missing for key '${String(key)}'`);
  }
  return value;
}

/**
 * Validate a scenario fails LOUD on a malformed / inadmissible input rather than silently
 * sampling garbage. (The TS types already exclude inadmissible per-item `a`/slip/guess
 * fields; this guards the numeric/structural contract.)
 */
export function assertValidScenario(scenario: SimScenario): void {
  if (scenario.kcs.length === 0) throw new Error('forward-sampler: scenario has no KCs');
  if (scenario.items.length === 0) throw new Error('forward-sampler: scenario has no items');
  const kcIds = new Set<string>();
  for (const kc of scenario.kcs) {
    if (kcIds.has(kc.id)) throw new Error(`forward-sampler: duplicate KC id '${kc.id}'`);
    kcIds.add(kc.id);
    if (!Number.isFinite(kc.trueTheta)) {
      throw new Error(`forward-sampler: KC '${kc.id}' trueTheta must be finite`);
    }
    if (kc.beta !== undefined && !Number.isFinite(kc.beta)) {
      throw new Error(`forward-sampler: KC '${kc.id}' beta must be finite`);
    }
  }
  for (const kc of scenario.kcs) {
    for (const pid of kc.prereqIds ?? []) {
      if (!kcIds.has(pid)) {
        throw new Error(`forward-sampler: KC '${kc.id}' prereq '${pid}' is not a known KC`);
      }
    }
  }
  for (const item of scenario.items) {
    if (!Number.isFinite(item.b)) {
      throw new Error(`forward-sampler: item '${item.id}' b must be finite`);
    }
    if (item.kcIds.length === 0) {
      throw new Error(`forward-sampler: item '${item.id}' taxes no KCs`);
    }
    for (const kid of item.kcIds) {
      if (!kcIds.has(kid)) {
        throw new Error(`forward-sampler: item '${item.id}' references unknown KC '${kid}'`);
      }
    }
  }
  const penalty = scenario.prereqPenalty ?? 0;
  if (!Number.isFinite(penalty) || penalty < 0) {
    throw new Error('forward-sampler: prereqPenalty must be a finite number >= 0');
  }
}

/**
 * GENERATIVE competence of a KC = the probability the TRUE model assigns at neutral
 * difficulty (b=0), used both for prereq-mastery gating and as the latent audit signal.
 *   - irt: σ(trueTheta) — static.
 *   - pfa: p(L) from the learner's OWN accruing success/fail (grows with practice).
 * Reuses the live `expectedScore` (the single sigmoid source) / `pLearned`.
 */
function trueCompetence(
  state: DgpKcState,
  model: ResponseModel,
  gamma: number,
  rho: number,
): number {
  if (model === 'pfa') {
    const beta = state.kc.beta ?? 0;
    return pLearned(beta, gamma, rho, state.dgpSuccess, state.dgpFail);
  }
  return expectedScore(state.kc.trueTheta, 0);
}

/** Count of a KC's prerequisites NOT yet generatively mastered. */
function unmetPrereqCount(
  kc: SimKc,
  dgp: Map<string, DgpKcState>,
  model: ResponseModel,
  gamma: number,
  rho: number,
  threshold: number,
): number {
  let unmet = 0;
  for (const pid of kc.prereqIds ?? []) {
    const pstate = dgp.get(pid);
    if (pstate === undefined) continue; // validated to exist, defensive.
    if (trueCompetence(pstate, model, gamma, rho) < threshold) unmet++;
  }
  return unmet;
}

/**
 * TRUE per-KC P(correct) on an item under the generative model, with KG prereq gating.
 *   - irt: σ(trueTheta − prereqPenalty·unmet − b).
 *   - pfa: σ(pfaLogit(beta, γ, ρ, success, fail) − prereqPenalty·unmet). Difficulty enters
 *          via beta (KC β if set, else the item's b — the live "representative b as β").
 * Single sigmoid source = `expectedScore` (respects POLY_SIGMOID flag, same as live).
 */
function trueKcPCorrect(
  item: SimItem,
  kc: SimKc,
  dgp: Map<string, DgpKcState>,
  scenario: Required<
    Pick<
      SimScenario,
      'responseModel' | 'pfaGamma' | 'pfaRho' | 'prereqPenalty' | 'masteryThreshold'
    >
  >,
): number {
  const { responseModel, pfaGamma, pfaRho, prereqPenalty, masteryThreshold } = scenario;
  const unmet = unmetPrereqCount(kc, dgp, responseModel, pfaGamma, pfaRho, masteryThreshold);
  const penalty = prereqPenalty * unmet;
  if (responseModel === 'pfa') {
    const state = dgp.get(kc.id);
    const beta = kc.beta ?? item.b;
    const success = state?.dgpSuccess ?? 0;
    const fail = state?.dgpFail ?? 0;
    const logit = pfaLogit(beta, pfaGamma, pfaRho, success, fail) - penalty;
    return expectedScore(logit, 0); // σ(logit)
  }
  // irt: σ((trueTheta − penalty) − b)
  return expectedScore(kc.trueTheta - penalty, item.b);
}

/** Default deterministic policy: round-robin over the item bank. */
export const roundRobinPolicy: SelectionPolicy = (ctx) =>
  ctx.items.length === 0 ? null : ctx.step % ctx.items.length;

// ── Core rollout ──────────────────────────────────────────────────────────────────────

/**
 * Roll out a synthetic learner trajectory using an INJECTED rng (the v-a1-fwd purity
 * pattern — the module never reaches for a global random). Same rng stream + same scenario
 * + same policy ⇒ BYTE-IDENTICAL trajectory.
 *
 * rng draw ORDER per step (fixed for determinism): policy draw → outcome draw → [RT draw].
 */
export function rolloutLearner(
  scenario: SimScenario,
  options: RolloutOptions,
  rng: () => number,
): RolloutResult {
  assertValidScenario(scenario);
  if (!Number.isInteger(options.horizon) || options.horizon < 0) {
    throw new Error('forward-sampler: horizon must be an integer >= 0');
  }

  const cfg = {
    responseModel: scenario.responseModel ?? 'irt',
    pfaGamma: scenario.pfaGamma ?? PFA_GAMMA,
    pfaRho: scenario.pfaRho ?? PFA_RHO,
    prereqPenalty: scenario.prereqPenalty ?? 0,
    masteryThreshold: scenario.masteryThreshold ?? 0.5,
  } as const;

  const policy = options.policy ?? roundRobinPolicy;
  const sampleRt = options.sampleResponseTime ?? false;

  const dgp = new Map<string, DgpKcState>();
  const est = new Map<string, EstKcState>();
  for (const kc of scenario.kcs) {
    dgp.set(kc.id, { kc, dgpSuccess: 0, dgpFail: 0 });
    // default precision 1 mirrors the live mastery_state backfill (weak prior, SE=1).
    est.set(kc.id, { thetaHat: 0, thetaPrecision: 1, estSuccess: 0, estFail: 0, attempts: 0 });
  }

  const beliefSnapshot = (): Record<string, KcBelief> => {
    const out: Record<string, KcBelief> = {};
    for (const kc of scenario.kcs) {
      const e = mustGet(est, kc.id);
      const beta = kc.beta ?? 0;
      out[kc.id] = {
        thetaHat: e.thetaHat,
        se: thetaSe(e.thetaPrecision),
        pLearned: pLearned(beta, cfg.pfaGamma, cfg.pfaRho, e.estSuccess, e.estFail),
        attempts: e.attempts,
      };
    }
    return out;
  };

  const steps: RolloutStep[] = [];

  for (let step = 0; step < options.horizon; step++) {
    const policyDraw = rng();
    const itemIndex = policy({
      step,
      horizon: options.horizon,
      items: scenario.items,
      belief: beliefSnapshot(),
      history: steps,
      draw: policyDraw,
    });
    if (itemIndex === null) break;
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= scenario.items.length) {
      throw new Error(
        `forward-sampler: policy returned out-of-range itemIndex ${itemIndex} (have ${scenario.items.length} items)`,
      );
    }
    const item = scenario.items[itemIndex];

    // GENERATIVE conjunctive P(correct) = ∏_k trueKcPCorrect (DINA: all KCs required).
    let pItem = 1;
    for (const kid of item.kcIds) {
      const kc = mustGet(dgp, kid).kc;
      pItem *= trueKcPCorrect(item, kc, dgp, cfg);
    }

    const outcomeDraw = rng();
    const outcome: 0 | 1 = outcomeDraw < pItem ? 1 : 0;

    // Optional RT (simplest admissible model: uniform fraction of the item time-limit d).
    let responseTimeSec: number | null = null;
    let srt: number | null = null;
    if (sampleRt) {
      const d = resolveSrtTimeLimit(item.difficulty ?? 3);
      const rtDraw = rng();
      responseTimeSec = d * rtDraw; // t ∈ [0, d)
      srt = srtOutcome(outcome === 1, d, responseTimeSec);
    }

    // ── Advance GENERATIVE state (PFA mode learns; IRT mode is static measurement). ──
    if (cfg.responseModel === 'pfa') {
      for (const kid of item.kcIds) {
        const s = mustGet(dgp, kid);
        if (outcome === 1) s.dgpSuccess++;
        else s.dgpFail++;
      }
    }

    // ── Advance ESTIMATOR state via the LIVE θ̂ credit path (what a policy observes). ──
    const itemKcStates = item.kcIds.map((kid) => mustGet(est, kid));
    const thetasBefore = itemKcStates.map((e) => e.thetaHat);
    const credits =
      srt !== null
        ? conjunctiveCreditsContinuous(thetasBefore, item.b, srt)
        : conjunctiveCredits(thetasBefore, item.b, outcome);
    for (let j = 0; j < itemKcStates.length; j++) {
      const e = itemKcStates[j];
      const k = eloK(e.attempts);
      e.thetaPrecision = updateThetaPrecision(e.thetaPrecision, e.thetaHat, item.b);
      e.thetaHat = e.thetaHat + k * credits[j];
      if (outcome === 1) e.estSuccess++;
      else e.estFail++;
      e.attempts++;
    }

    const beliefAfterFull = beliefSnapshot();
    const beliefAfter: Record<string, KcBelief> = {};
    for (const kid of item.kcIds) beliefAfter[kid] = beliefAfterFull[kid];

    steps.push({
      index: step,
      itemIndex,
      itemId: item.id,
      pCorrect: pItem,
      outcome,
      responseTimeSec,
      srtOutcome: srt,
      beliefAfter,
    });
  }

  const trueComp: Record<string, number> = {};
  for (const kc of scenario.kcs) {
    trueComp[kc.id] = trueCompetence(
      mustGet(dgp, kc.id),
      cfg.responseModel,
      cfg.pfaGamma,
      cfg.pfaRho,
    );
  }

  return { steps, finalBelief: beliefSnapshot(), trueCompetence: trueComp };
}

/**
 * Convenience: roll out from an integer seed (constructs a mulberry32 stream internally).
 * Same seed ⇒ identical trajectory — the headline determinism contract.
 */
export function seededRollout(
  scenario: SimScenario,
  options: RolloutOptions,
  seed: number,
): RolloutResult {
  return rolloutLearner(scenario, options, mulberry32(seed));
}
