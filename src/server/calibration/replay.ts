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
  resolveSrtTimeLimit,
  srtOutcome,
} from '@/core/theta';

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
}

export interface ReplayResult {
  steps: ReplayStep[];
  /** running POST-attempt state after the full sequence (for the faithfulness fixture). */
  finalState: ReplayFinalState;
}

function isFiniteNum(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

// PERSISTENCE-PRECISION NOTE (faithfulness bound, surfaced in the PR description):
//   production persists θ̂ to Postgres `real` columns (mastery_state.theta_hat /
//   ability_global theta_hat — src/db/schema.ts:821,833) and re-reads them between
//   attempts (getMasteryState → states[i].theta). The `postgres` driver round-trips a
//   `real` value through its TEXT serialization (~7 significant decimal digits), e.g.
//   0.28877070890471374 → '0.2887707' → parseFloat = 0.2887707 — which is NEITHER the
//   original float64 NOR Math.fround(x) (0.2887707054615021). There is no cheap pure-JS
//   reproduction of Postgres's float-to-text algorithm, so the replay stays pure float64
//   (the natural in-memory arithmetic) and the byte-identity fixture asserts agreement to
//   ~1e-6 (float32/real-text precision) — the actual precision the LIVE θ̂ trajectory
//   carries. The forward-AUC verdict is robust to this: σ() of a ~1e-6 θ̂ difference moves
//   the predicted P by ~1e-6, far below any ranking-flip / ΔAUC-threshold scale.

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
 */
export function replayTheta(
  orderedAttempts: ReplayAttempt[],
  opts: { srtEnabled: boolean },
): ReplayResult {
  // Mutable in-memory state — the DB rows production reads/upserts, held in maps.
  const thetaKc = new Map<string, number>();
  const evidence = new Map<string, number>();
  const thetaGlobal = new Map<string, number>();

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
    if (a.scoredKnowledgeId !== null) {
      const sk = a.scoredKnowledgeId;
      const pre = (thetaKc.get(sk) ?? 0) + globalOf(sk);
      steps.push({
        eventId: a.eventId,
        scoredKnowledgeId: sk,
        preAttemptEffectiveTheta: pre,
        b: a.b,
        predictedP: expectedScore(pre, a.b), // 1PL: P = σ(θ̂_{t−1} − b_effective)
        outcome: a.outcome,
        hasRt,
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
      });
    }

    // ── APPLY UPDATE (full multi-KC, mirrors state.ts:627-637) ──
    const useSrt = opts.srtEnabled && isFiniteNum(a.responseTimeMs);
    let credits: number[];
    if (useSrt) {
      const d = resolveSrtTimeLimit(a.difficulty); // seconds (module const)
      const tSeconds = (a.responseTimeMs as number) / 1000; // ms → s
      const srt = srtOutcome(a.outcome === 1, d, tSeconds); // ∈ [0,1]
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
  }

  return { steps, finalState: { thetaKc, thetaGlobal, evidence } };
}
