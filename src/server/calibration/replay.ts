// PURE in-memory θ̂ replay engine (YUK-461, axis-2 Wave-0).
//
// Re-derives the per-KC θ̂ trajectory from an ordered attempt log under a SRT flag
// VARIANT (srtEnabled on/off), purely in-memory, WITHOUT touching live DB state.
//
// ⚠ FAITHFULNESS IS THE WHOLE POINT. This module re-implements the production credit
// loop ARITHMETIC (src/server/mastery/state.ts:453-736) but REUSES the exact production
// primitives from @/core/theta — re-deriving any of expectedScore / eloK /
// conjunctiveCredits / conjunctiveCreditsContinuous / srtOutcome / resolveSrtTimeLimit /
// ELO_K_GLOBAL is a BUG. The byte-identity proof lives in replay.fixture.db.test.ts,
// which drives the REAL updateThetaForAttempt over a short sequence and asserts the
// resulting θ_KC / θ_global match this engine bit-for-bit.
//
// DESIGN: the replay matches production EXACTLY when the flag matches live
//   (srtEnabled === SRT_ENABLED). The engine is PURE: (ordered attempt records + flag)
//   → (θ̂ trajectory + per-step PRE-attempt θ̂). The DB-loading of attempt records is a
//   THIN, separate seam (scripts/audit-calibration.ts) — this module never touches the DB.
//
// SCOPE (B2 resolution b): replays the FULL multi-KC update for every attempt that
//   touches a scoped KC (trajectory fidelity — a KC's production θ̂ folds in updates
//   from every multi-KC question that also probes it), but emits a forward-SCORABLE
//   step ONLY when the attempt's question is single-KC (scoredKnowledgeId !== null).
//   The V-A1-fwd gate scores only those single-KC steps.
//
// A2 (HIERARCHICAL_ELO_ENABLED): read as the LIVE module const — both SRT variants
//   share it, so ΔAUC isolates SRT. When the live flag is on, effective θ for a KC =
//   θ_global(domain) + θ_KC, and θ_global drifts once per touched domain per attempt.
//
// FORWARD NO-LEAKAGE: the per-attempt forward step (predictedP from the PRE-attempt
//   effective θ̂) is emitted BEFORE any θ̂ write. outcome_t never forms θ̂_{t−1}.

import {
  ELO_K_GLOBAL,
  HIERARCHICAL_ELO_ENABLED,
  conjunctiveCredits,
  conjunctiveCreditsContinuous,
  eloK,
  expectedScore,
  pushRtCorrectSample,
  resolveSrtTimeLimit,
  resolveSrtTimeLimitFromQuantile,
  srtOutcome,
} from '@/core/theta';
import {
  type ThetaGridPosterior,
  gridUpdate,
  posteriorMean,
  uniformPrior,
} from '@/core/theta-grid';

// ─────────────────────────────────────────────────────────────────────────────
// A4 (YUK-436) GRID TRACK — pure-additive shadow replay of the discrete grid-Bayes
// θ_KC OFFSET posterior, ALONGSIDE the Elo θ̂ track above. READ-ONLY harness use:
// it lets pnpm audit:calibration retro-validate the DARK grid path against the LIVE
// Elo path WITHOUT ever flipping THETA_GRID_ENABLED or writing the DB.
//
// ⚠ FAITHFULNESS to the production shadow write (state.ts:815-828) is the whole point;
//   the grid faithfulness fixture (replay.fixture.db.test.ts) drives the REAL
//   updateThetaForAttempt with THETA_GRID_ENABLED mocked TRUE and asserts this track's
//   final per-KC posterior == the persisted theta_grid_json. Rules, mirrored exactly:
//
//   • SINGLE-KC ONLY. Production folds the grid only when states.length === 1; the
//     forward-scorable replay step (scoredKnowledgeId !== null) is the same single-KC
//     gate. Multi-KC attempts get NO grid forward step and NO fold (gridPredictedP=null).
//   • BINARY likelihood only (gridUpdate → binaryLikelihood). The continuous-CB path is
//     gated off inc-1; we never wire continuousCbLikelihood here.
//   • COLD START: a KC with no prior posterior folds from uniformPrior().
//   • θ_global TRANSLATION ANCHOR — the SUBTLE part. Production's grid fold computes
//     bPrime = b − globalOf(scoredKC), where globalOf reads `globalThetaOfDomain`. That
//     map is populated ONCE pre-attempt (state.ts:627) and is NEVER mutated by the
//     θ_global drift block (state.ts:722-776). So production folds with the PRE-attempt
//     θ_global, identical to the value the forward step uses. We therefore capture
//     preGlobal for the scored KC BEFORE this engine's drift block mutates thetaGlobal,
//     and use that SAME preGlobal for BOTH the forward prediction and the fold. (The
//     task's "postGlobal" phrasing does not match production — globalThetaOfDomain never
//     sees the drift — and the fixture proves the pre-attempt anchor.)
//   • FORWARD NO-LEAKAGE: gridPredictedP is emitted from the PRE-fold posterior, BEFORE
//     the fold advances it — outcome_t never forms the prediction of outcome_t.
//   • FLAG OFF (opts.gridEnabled false/absent): ZERO grid computation — gridPredictedP
//     stays null on every step and thetaGridByKc stays empty (byte-identical regression).
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayAttempt {
  /** the question's FULL KC set (production updates all of them — state.ts:457). */
  knowledgeIds: string[];
  /** the single scored KC iff the question is single-KC; else null (not forward-scorable). */
  scoredKnowledgeId: string | null;
  /** resolved effective domain per KC (loader-memoized; null = orphan/unresolved). */
  domainByKc: Record<string, string | null>;
  /** binary outcome: success=1, failure=0. */
  outcome: 0 | 1;
  /** difficulty (1-5) — feeds resolveSrtTimeLimit's d. */
  difficulty: number;
  /** production's FULL b = effectiveFamilyB(columnarB, familyRow) — loader-precomputed (B3). */
  b: number;
  /** calB!==null ? 1 : DIFFICULTY_PROXY_WEIGHT — loader-precomputed. */
  bWeight: number;
  /** RT in ms; null → binary even when srtEnabled (mirrors state.ts:628 useSrt gate). */
  responseTimeMs: number | null;
  /** epoch ms — loader PRE-sorts; the engine assumes the list is already time-ordered. */
  createdAt: number;
  /** provenance + stable tiebreak. */
  eventId: string;
}

export interface ReplayStep {
  eventId: string;
  /** null → NOT a forward-scorable step (multi-KC question). */
  scoredKnowledgeId: string | null;
  /** θ_KC_{t−1}(scored) + θ_global_{t−1}(scored's domain); null if not scorable. */
  preAttemptEffectiveTheta: number | null;
  /** production's full b for this attempt (reported for traceability). */
  b: number;
  /** expectedScore(preAttemptEffectiveTheta, b); null if not scorable. */
  predictedP: number | null;
  outcome: 0 | 1;
  /** responseTimeMs is a finite number (for the N_with_rt split, M4). */
  hasRt: boolean;
  /**
   * A4 (YUK-436) — the PRE-attempt GRID forward prediction:
   * expectedScore(preGlobal + posteriorMean(priorPosterior ?? uniformPrior()), b),
   * emitted BEFORE the grid fold (no-leakage). null when !opts.gridEnabled OR the
   * attempt is not single-KC-scorable (scoredKnowledgeId === null). The Elo
   * `predictedP` above is the LIVE comparison baseline; this is the DARK grid path.
   */
  gridPredictedP: number | null;
}

/**
 * The running POST-attempt in-memory state after the whole sequence replays — the maps
 * production persists to mastery_state. Exposed so the faithfulness fixture
 * (replay.fixture.db.test.ts) can directly compare the final θ_KC / θ_global to what the
 * real updateThetaForAttempt wrote, without probe trickery. (The forward gate ignores
 * this; it consumes only the per-step PRE-attempt predictions.)
 */
export interface ReplayFinalState {
  /** per-KC θ_KC offset (the 'knowledge' mastery_state.theta_hat). */
  thetaKc: Map<string, number>;
  /** per-domain θ_global ('ability_global' mastery_state.theta_hat). */
  thetaGlobal: Map<string, number>;
  /** per-KC evidence_count (for completeness; not asserted by the gate). */
  evidence: Map<string, number>;
  /**
   * A4 (YUK-436) — final per-KC grid-Bayes posterior over the θ_KC OFFSET (the maps
   * production persists shadow-only to mastery_state.theta_grid_json). EMPTY when
   * !opts.gridEnabled. The grid faithfulness fixture compares get(kc).probs to the
   * persisted theta_grid_json.probs elementwise.
   */
  thetaGridByKc: Map<string, ThetaGridPosterior>;
}

export interface ReplayResult {
  steps: ReplayStep[];
  /** running POST-attempt state after the full sequence (for the faithfulness fixture). */
  finalState: ReplayFinalState;
}

function isFiniteNum(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

// PERSISTENCE-PRECISION NOTE (faithfulness bound):
//   As of YUK-495 S4, production persists θ̂ to a Postgres `double precision` column
//   (mastery_state.theta_hat — src/db/schema.ts:880; the per-domain 'ability_global' θ̂ is
//   itself a mastery_state row, not a separate table) and re-reads it between attempts
//   (getMasteryState → states[i].theta). double precision is binary64, so the `postgres`
//   driver now round-trips the LIVE θ̂ **bit-exactly** (no float32/real-text truncation —
//   the old note here described the pre-S4 `real` column, where 0.28877070890471374 read
//   back as 0.2887707). The replay stays pure float64 (the natural in-memory arithmetic),
//   so the persistence layer no longer introduces a precision gap.
//   The byte-identity fixture still asserts agreement to ~1e-6 — now a CONSERVATIVE bound,
//   not the persistence limit: any residual gap is replay-recompute arithmetic, not column
//   truncation. Tightening this toward bit-exact is the Tier-2 bit-exact-replay slice's job
//   (#46 / decision-②: the replay recompute must route through the shared polySigmoid that
//   the live θ̂ uses once POLY_SIGMOID_ENABLED flips). The forward-AUC verdict is robust to
//   the current bound regardless: σ() of a ~1e-6 θ̂ difference moves predicted P by ~1e-6,
//   far below any ranking-flip / ΔAUC-threshold scale.

/** Dedup + trim + drop-empty, identical to state.ts:457-459. */
function dedupKcs(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
}

/**
 * Replay the per-KC θ̂ trajectory over an ordered attempt list under a SRT variant.
 *
 * @param orderedAttempts time-ordered attempt records (loader sorts by created_at, id).
 * @param opts.srtEnabled the SRT variant: true → continuous srtOutcome credit when RT
 *   present; false → binary credit always. (Maps to the real SRT_ENABLED const — the
 *   fixture proves srtEnabled:true == live SRT_ENABLED:true and srtEnabled:false ==
 *   SRT_ENABLED:false.)
 * @param opts.gridEnabled A4 (YUK-436) grid track. Default false → ZERO grid computation
 *   (gridPredictedP null on every step, thetaGridByKc empty — byte-identical regression).
 *   true → the per-KC grid-Bayes offset posterior is folded shadow-only ALONGSIDE the Elo
 *   track (single-KC-scorable attempts only), mirroring the production shadow write
 *   (state.ts:815-828). NEVER flips THETA_GRID_ENABLED, NEVER touches the DB.
 * @param opts.fisherWeightEnabled A1 (YUK-450) Fisher-conditioned time weight. Default false →
 *   timeWeight = 1 → byte-identical regression. true → timeWeight = 4·pItem·(1−pItem) at the
 *   SRT seam (maps to the real SRT_FISHER_WEIGHT_ENABLED const).
 * @param opts.dFromQuantile A1 (YUK-449) per-KC rolling RT quantile as d. Default false → d =
 *   population seed (resolveSrtTimeLimit) → byte-identical regression. true → d = quantile of
 *   the PRIMARY KC's PRIOR correct RTs (≥ SRT_RT_MIN_N, else seed). Causal by construction (only
 *   attempts BEFORE the current one inform d) → NO forward-validation in-sample leakage. Maps to
 *   the real SRT_D_FROM_QUANTILE const.
 */
export function replayTheta(
  orderedAttempts: ReplayAttempt[],
  opts: {
    srtEnabled: boolean;
    gridEnabled?: boolean;
    fisherWeightEnabled?: boolean;
    dFromQuantile?: boolean;
  },
): ReplayResult {
  // Mutable in-memory state — the DB rows production reads/upserts, held in maps.
  const thetaKc = new Map<string, number>();
  const evidence = new Map<string, number>();
  const thetaGlobal = new Map<string, number>();
  // A4 (YUK-436) grid track — per-KC running posterior over the θ_KC offset (the map
  // production persists shadow-only to theta_grid_json). Stays empty when !gridEnabled.
  const thetaGridByKc = new Map<string, ThetaGridPosterior>();
  const gridEnabled = opts.gridEnabled ?? false;
  const fisherWeightEnabled = opts.fisherWeightEnabled ?? false;
  const dFromQuantile = opts.dFromQuantile ?? false;
  // A1 (YUK-449) — causal per-KC correct-RT buffer (mirrors mastery_state.rt_correct_ms). The
  // d-read below sees only PRIOR attempts' RTs (this attempt's RT is pushed AFTER the update),
  // so quantile-d carries no forward-validation leakage. Stays unused when !dFromQuantile.
  const rtBufferByKc = new Map<string, number[]>();

  const steps: ReplayStep[] = [];

  for (const a of orderedAttempts) {
    const kcs = dedupKcs(a.knowledgeIds);
    // state.ts:460 — empty KC set → early return (no step, no update).
    if (kcs.length === 0) continue;

    // globalOf mirrors state.ts:600-603 (flag off OR unresolved domain → 0).
    const globalOf = (kcId: string): number => {
      const domain = a.domainByKc[kcId] ?? null;
      return domain !== null && HIERARCHICAL_ELO_ENABLED ? (thetaGlobal.get(domain) ?? 0) : 0;
    };

    // effectiveThetas[i] = θ_KC + θ_global(domain) — PRE-attempt (state.ts:604).
    const effectiveThetas = kcs.map((kc) => (thetaKc.get(kc) ?? 0) + globalOf(kc));

    // ── FORWARD STEP (emit BEFORE any write — no-leakage) ──
    const hasRt = isFiniteNum(a.responseTimeMs);
    // ── A4 grid FOLD capture (gated on production's REAL fold condition) ──
    // Production folds the grid posterior iff the DEDUPED KC set is single — state.ts:815
    // `THETA_GRID_ENABLED && states.length === 1`, where states = dedupe(referencedKnowledgeIds)
    // = `kcs` here. This is the deduped REFERENCED set, NOT the question's KC cardinality
    // (scoredKnowledgeId, which keys off q.knowledge_ids.length — audit-calibration.ts:347).
    // They coincide for canonical single-KC items but DIVERGE on the paper path (slot may
    // reference a secondary KC on a single-KC question, or reference only one KC of a multi-KC
    // question). Gate the FOLD on kcs.length===1 (production-faithful) and DECOUPLE it from the
    // forward prediction (gated on scoredKnowledgeId below). Capture the fold KC's PRE-attempt
    // θ_global + pre-fold posterior NOW (before the drift block mutates thetaGlobal) so the TAIL
    // fold reuses the same pre-attempt anchor production's globalOf returns (state.ts:627 vs
    // 722-776 — the drift never mutates globalThetaOfDomain).
    let gridFoldKc: string | null = null;
    let gridFoldPrior: ThetaGridPosterior | null = null;
    let gridFoldPreGlobal = 0;
    if (gridEnabled && kcs.length === 1) {
      gridFoldKc = kcs[0];
      gridFoldPreGlobal = globalOf(kcs[0]);
      gridFoldPrior = thetaGridByKc.get(kcs[0]) ?? uniformPrior();
    }
    if (a.scoredKnowledgeId !== null) {
      const sk = a.scoredKnowledgeId;
      const pre = (thetaKc.get(sk) ?? 0) + globalOf(sk);
      // A4 grid FORWARD prediction (PRE-fold posterior; null when !gridEnabled). Gated on
      // forward-scorability (scoredKnowledgeId !== null = single-KC QUESTION, where the live
      // Elo step also predicts), reading the SCORED KC's posterior-so-far + its pre-attempt
      // θ_global (globalOf, read before the drift). DECOUPLED from the fold gate above: in the
      // canonical single-KC case sk === kcs[0] (predict + fold same KC, same pre-fold posterior
      // — no leakage); on the paper path they can differ, each independently matching production.
      // +preGlobal form for parity with the live step (≡ expectedScore(posteriorMean, b−preGlobal)).
      let gridPredictedP: number | null = null;
      if (gridEnabled) {
        const predPrior = thetaGridByKc.get(sk) ?? uniformPrior();
        gridPredictedP = expectedScore(globalOf(sk) + posteriorMean(predPrior), a.b);
      }
      steps.push({
        eventId: a.eventId,
        scoredKnowledgeId: sk,
        preAttemptEffectiveTheta: pre,
        b: a.b,
        predictedP: expectedScore(pre, a.b), // 1PL: P = σ(θ̂_{t−1} − b_effective)
        outcome: a.outcome,
        hasRt,
        gridPredictedP,
      });
    } else {
      steps.push({
        eventId: a.eventId,
        scoredKnowledgeId: null,
        preAttemptEffectiveTheta: null,
        b: a.b,
        predictedP: null,
        outcome: a.outcome,
        hasRt,
        gridPredictedP: null,
      });
    }

    // ── APPLY UPDATE (full multi-KC, mirrors state.ts:627-637) ──
    const useSrt = opts.srtEnabled && isFiniteNum(a.responseTimeMs);
    let credits: number[];
    if (useSrt) {
      // A1 (YUK-449) — d source: PRIOR-only per-KC quantile (causal) vs population seed.
      const d = dFromQuantile
        ? resolveSrtTimeLimitFromQuantile(rtBufferByKc.get(kcs[0]) ?? null, a.difficulty)
        : resolveSrtTimeLimit(a.difficulty); // seconds (module const)
      const tSeconds = (a.responseTimeMs as number) / 1000; // ms → s
      // A1 (YUK-450) — Fisher-conditioned time weight (4·pItem·(1−pItem)); pItem = whole-item
      // p(correct) from the running effective θ̂ + b anchor. Flag off → w=1 → byte-identical.
      const pItem = effectiveThetas.reduce((acc, th) => acc * expectedScore(th, a.b), 1);
      const timeWeight = fisherWeightEnabled ? 4 * pItem * (1 - pItem) : 1;
      const srt = srtOutcome(a.outcome === 1, d, tSeconds, timeWeight); // ∈ [0,1]
      credits = conjunctiveCreditsContinuous(effectiveThetas, a.b, srt);
    } else {
      credits = conjunctiveCredits(effectiveThetas, a.b, a.outcome);
    }

    // per-KC offset update (state.ts:647-650). θ_KC += k · bWeight · credit_k. Pure
    // float64 (production computes this same arithmetic in-memory; the only divergence is
    // the `real`-column persistence between attempts — see the PERSISTENCE-PRECISION note).
    for (let i = 0; i < kcs.length; i++) {
      const kc = kcs[i];
      const k = eloK(evidence.get(kc) ?? 0);
      thetaKc.set(kc, (thetaKc.get(kc) ?? 0) + k * a.bWeight * credits[i]);
      evidence.set(kc, (evidence.get(kc) ?? 0) + 1);
    }

    // A1 (YUK-449) — POST-update causal RT collection (mirrors state.ts: push the item RT into
    // each touched KC's buffer ONLY on an SRT-eligible correct attempt). Done AFTER the d-read
    // above, so the next attempt's quantile sees this one but THIS attempt's d did not → no
    // leakage. Harmless when !dFromQuantile (buffer is never read) → existing fixtures unchanged.
    if (useSrt && a.outcome === 1) {
      for (const kc of kcs) {
        rtBufferByKc.set(
          kc,
          pushRtCorrectSample(rtBufferByKc.get(kc) ?? null, a.responseTimeMs as number),
        );
      }
    }

    // ── per-domain θ_global drift (state.ts:682-735), ONCE per touched domain ──
    if (HIERARCHICAL_ELO_ENABLED) {
      const creditsByDomain = new Map<string, number[]>();
      for (let i = 0; i < kcs.length; i++) {
        const domain = a.domainByKc[kcs[i]] ?? null;
        if (domain === null) continue;
        const list = creditsByDomain.get(domain) ?? [];
        list.push(credits[i]);
        creditsByDomain.set(domain, list);
      }
      // Sorted domain order (state.ts:695) — irrelevant for the value (each domain
      // drifts independently), kept for parity with the production acquire order.
      for (const domain of [...creditsByDomain.keys()].sort()) {
        const domainCredits = creditsByDomain.get(domain) as number[];
        const aggregateCredit = domainCredits.reduce((acc, c) => acc + c, 0) / domainCredits.length;
        // Sequential single-user replay: the pre-attempt global IS production's re-read
        // lockedGlobal (no concurrent same-domain attempt) — M3, asserted in the fixture.
        const current = thetaGlobal.get(domain) ?? 0;
        thetaGlobal.set(domain, current + ELO_K_GLOBAL * a.bWeight * aggregateCredit);
      }
    }

    // ── A4 (YUK-436) GRID FOLD — at the TAIL, after the θ_global drift (state.ts:815) ──
    // Gated on kcs.length === 1 (production's `states.length === 1` over the deduped REFERENCED
    // KC set), INDEPENDENT of forward-scorability — captured above (gridFoldKc). bPrime uses the
    // PRE-attempt θ_global (gridFoldPreGlobal, captured before the drift block) because
    // production's globalThetaOfDomain is never mutated by the drift — globalOf at the fold site
    // still returns the pre-attempt value (state.ts:627 vs 722-776). Advances the same pre-fold
    // posterior (no-leakage: the forward prediction was already emitted above).
    if (gridFoldKc !== null) {
      const prior = gridFoldPrior ?? uniformPrior();
      const bPrime = a.b - gridFoldPreGlobal; // b' = b − θ_global (pre-attempt anchor)
      thetaGridByKc.set(gridFoldKc, gridUpdate(prior, bPrime, a.outcome));
    }
  }

  return { steps, finalState: { thetaKc, thetaGlobal, evidence, thetaGridByKc } };
}
