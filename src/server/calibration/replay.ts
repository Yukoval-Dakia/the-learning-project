// In-memory θ̂ replay. Reuse the @/core/theta primitives. Re-deriving them is a bug.
// Attempt loading stays in scripts/audit-calibration.ts. This module never touches the database.
// The faithfulness fixture drives the real updateThetaForAttempt and compares the final maps.
//
// Every non-empty attempt applies the full multi-KC update and pushes a step.
// predictedP is set only for a single-KC question. A multi-KC step leaves it null
// unless multiKcScoring fills the conjunctive item fields.
// Both SRT variants share the live HIERARCHICAL_ELO_ENABLED flag, so ΔAUC isolates SRT.
// The step is pushed before any θ̂ write. outcome_t never forms θ̂_{t−1}.
//
// The grid track is a read-only shadow. It never flips THETA_GRID_ENABLED and never writes.
// Production folds only when the deduped referenced KC set has length 1. That set is `kcs`,
// not the question cardinality behind scoredKnowledgeId. A paper slot can reference a
// secondary KC, so the fold gate and the forward prediction can name different KCs.
// The likelihood is binary. A KC with no posterior starts from uniformPrior().
// Production fills globalOf once, before the attempt, and the drift does not mutate that map.
// The fold keeps the referenced KC's pre-drift global. The prediction reads the scored KC
// before the drift. Those reads match only when the scored KC is the folded KC.
// With the grid flag off, every grid field stays null and thetaGridByKc stays empty.

import {
  ELO_K_GLOBAL,
  HIERARCHICAL_ELO_ENABLED,
  conjunctiveCredits,
  conjunctiveCreditsContinuous,
  conjunctiveItemProb,
  eloK,
  expectedScore,
  resolveSrtTimeLimit,
  srtOutcome,
} from '@/core/theta';
import {
  type ThetaGridPosterior,
  gridUpdate,
  posteriorMean,
  uniformPrior,
} from '@/core/theta-grid';

export interface ReplayAttempt {
  /** Full KC set. Production updates every member. */
  knowledgeIds: string[];
  /** The single scored KC, or null when the question is not forward-scorable. */
  scoredKnowledgeId: string | null;
  /** Effective domain per KC. Null skips hierarchical drift for that KC. */
  domainByKc: Record<string, string | null>;
  /** Binary outcome. Success is 1. */
  outcome: 0 | 1;
  /** Feeds the SRT time limit. */
  difficulty: number;
  /** Loader-precomputed effective b. The engine does not re-derive the family anchor. */
  b: number;
  /** Loader-precomputed. 1 when a calibrated b exists, else the difficulty-proxy weight. */
  bWeight: number;
  /** Null forces binary credit even when SRT is on. */
  responseTimeMs: number | null;
  /** Epoch ms. The loader sorts. The engine trusts that order. */
  createdAt: number;
  /** Provenance and the sort tiebreak. */
  eventId: string;
}

export interface ReplayStep {
  eventId: string;
  /** Null when the question is multi-KC. */
  scoredKnowledgeId: string | null;
  /** θ_KC plus θ_global of the scored domain, before this attempt. */
  preAttemptEffectiveTheta: number | null;
  b: number;
  /** expectedScore of the pre-attempt θ̂. Null when the question is not single-KC. */
  predictedP: number | null;
  outcome: 0 | 1;
  /** Finite RT. The RT-less split uses this. */
  hasRt: boolean;
  /**
   * Grid prediction from the pre-fold posterior. Null when the grid track is off
   * or the question is not single-KC. predictedP above is the live Elo baseline.
   */
  gridPredictedP: number | null;
  /**
   * Conjunctive item probability over the same pre-attempt thetas as the credit path.
   * Emitted only for a multi-KC attempt when multiKcScoring is on, and before any θ̂ write.
   */
  itemPredictedP: number | null;
  /**
   * Sorted KC ids joined by '|'. One attempt joins one cluster, so the paired bootstrap
   * does not leak between single-KC and combo clusters. Null when itemPredictedP is null.
   */
  itemClusterKey: string | null;
}

/**
 * Post-attempt maps after the whole sequence. The faithfulness fixture compares them
 * with what updateThetaForAttempt wrote. The forward gate reads only the pre-attempt steps.
 */
export interface ReplayFinalState {
  /** Per-KC offset. */
  thetaKc: Map<string, number>;
  /** Per-domain ability. */
  thetaGlobal: Map<string, number>;
  /** Not read by the forward gate. The fixture can still see evidence growth. */
  evidence: Map<string, number>;
  /**
   * Final grid posterior per KC. Empty when the grid track is off.
   * The fixture compares probs with the persisted theta_grid_json.
   */
  thetaGridByKc: Map<string, ThetaGridPosterior>;
}

export interface ReplayResult {
  steps: ReplayStep[];
  /** Post-attempt state after the full sequence, for the faithfulness fixture. */
  finalState: ReplayFinalState;
}

function isFiniteNum(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

// Production persists θ̂ as double precision, and the driver round-trips binary64.
// The fixture still allows about 1e-6. That bound is conservative. A residual gap is
// replay arithmetic, not column truncation, and it moves predicted P by about the same
// amount, below any ΔAUC threshold.

/** Same trim and drop-empty as production's KC set. */
function dedupKcs(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
}

/**
 * Replay θ̂ over an ordered attempt list.
 *
 * srtEnabled true uses continuous credit when an RT is present. False is always binary.
 * gridEnabled defaults false and then does no grid work.
 * multiKcScoring defaults false. True emits a conjunctive item prediction for each
 * multi-KC attempt and does not change credit or drift.
 * fisherWeightEnabled defaults false, so the time weight stays 1. True uses 4·p·(1−p)
 * at the SRT seam.
 */
export function replayTheta(
  orderedAttempts: ReplayAttempt[],
  opts: {
    srtEnabled: boolean;
    gridEnabled?: boolean;
    multiKcScoring?: boolean;
    fisherWeightEnabled?: boolean;
  },
): ReplayResult {
  const thetaKc = new Map<string, number>();
  const evidence = new Map<string, number>();
  const thetaGlobal = new Map<string, number>();
  const thetaGridByKc = new Map<string, ThetaGridPosterior>();
  const gridEnabled = opts.gridEnabled ?? false;
  const multiKcScoring = opts.multiKcScoring ?? false;
  const fisherWeightEnabled = opts.fisherWeightEnabled ?? false;

  const steps: ReplayStep[] = [];

  for (const a of orderedAttempts) {
    const kcs = dedupKcs(a.knowledgeIds);
    // Production returns before any write when the KC set is empty.
    if (kcs.length === 0) continue;

    // Flag off, or an unresolved domain, contributes 0.
    const globalOf = (kcId: string): number => {
      const domain = a.domainByKc[kcId] ?? null;
      return domain !== null && HIERARCHICAL_ELO_ENABLED ? (thetaGlobal.get(domain) ?? 0) : 0;
    };

    const effectiveThetas = kcs.map((kc) => (thetaKc.get(kc) ?? 0) + globalOf(kc));

    const hasRt = isFiniteNum(a.responseTimeMs);
    // Fold gate is the deduped referenced set, captured before drift mutates thetaGlobal.
    // The forward prediction below uses scoredKnowledgeId and can name a different KC.
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
        predictedP: expectedScore(pre, a.b),
        outcome: a.outcome,
        hasRt,
        gridPredictedP,
        // Single-KC scoring stays on predictedP, so these stay null and the attempt is not scored twice.
        itemPredictedP: null,
        itemClusterKey: null,
      });
    } else {
      // One item-level outcome. The product uses the same pre-attempt thetas as the credit path.
      // Off by default, so both fields stay null.
      let itemPredictedP: number | null = null;
      let itemClusterKey: string | null = null;
      if (multiKcScoring) {
        itemPredictedP = conjunctiveItemProb(effectiveThetas, a.b);
        itemClusterKey = [...kcs].sort().join('|');
      }
      steps.push({
        eventId: a.eventId,
        scoredKnowledgeId: null,
        preAttemptEffectiveTheta: null,
        b: a.b,
        predictedP: null,
        outcome: a.outcome,
        hasRt,
        gridPredictedP: null,
        itemPredictedP,
        itemClusterKey,
      });
    }

    const useSrt = opts.srtEnabled && isFiniteNum(a.responseTimeMs);
    let credits: number[];
    if (useSrt) {
      const d = resolveSrtTimeLimit(a.difficulty);
      const tSeconds = (a.responseTimeMs as number) / 1000;
      // Flag off keeps the weight at 1, so the SRT path matches the unweighted replay.
      const pItem = effectiveThetas.reduce((acc, th) => acc * expectedScore(th, a.b), 1);
      const timeWeight = fisherWeightEnabled ? 4 * pItem * (1 - pItem) : 1;
      const srt = srtOutcome(a.outcome === 1, d, tSeconds, timeWeight);
      credits = conjunctiveCreditsContinuous(effectiveThetas, a.b, srt);
    } else {
      credits = conjunctiveCredits(effectiveThetas, a.b, a.outcome);
    }

    for (let i = 0; i < kcs.length; i++) {
      const kc = kcs[i];
      const k = eloK(evidence.get(kc) ?? 0);
      thetaKc.set(kc, (thetaKc.get(kc) ?? 0) + k * a.bWeight * credits[i]);
      evidence.set(kc, (evidence.get(kc) ?? 0) + 1);
    }

    // Once per touched domain. The sort matches production's lock order. Each domain drifts on its own.
    // This replay is single-user, so the map value is the locked pre-attempt global.
    if (HIERARCHICAL_ELO_ENABLED) {
      const creditsByDomain = new Map<string, number[]>();
      for (let i = 0; i < kcs.length; i++) {
        const domain = a.domainByKc[kcs[i]] ?? null;
        if (domain === null) continue;
        const list = creditsByDomain.get(domain) ?? [];
        list.push(credits[i]);
        creditsByDomain.set(domain, list);
      }
      for (const domain of [...creditsByDomain.keys()].sort()) {
        const domainCredits = creditsByDomain.get(domain) as number[];
        const aggregateCredit = domainCredits.reduce((acc, c) => acc + c, 0) / domainCredits.length;
        const current = thetaGlobal.get(domain) ?? 0;
        thetaGlobal.set(domain, current + ELO_K_GLOBAL * a.bWeight * aggregateCredit);
      }
    }

    // After the drift. b' uses the pre-attempt global captured above, because production's
    // globalOf map is not updated by the drift. The prediction was already emitted.
    if (gridFoldKc !== null) {
      const prior = gridFoldPrior ?? uniformPrior();
      const bPrime = a.b - gridFoldPreGlobal;
      thetaGridByKc.set(gridFoldKc, gridUpdate(prior, bPrime, a.outcome));
    }
  }

  return { steps, finalState: { thetaKc, thetaGlobal, evidence, thetaGridByKc } };
}
