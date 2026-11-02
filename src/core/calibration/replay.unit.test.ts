// TASK 6 — PURE in-memory θ̂ replay engine. Re-derives the per-KC θ̂ trajectory from an
// ordered attempt log under a SRT flag VARIANT, reusing the EXACT production primitives
// from @/core/theta (expectedScore / eloK / conjunctiveCredits / conjunctiveCreditsContinuous
// / srtOutcome / resolveSrtTimeLimit / ELO_K_GLOBAL). Hand-computed anchors mirror
// state.ts:453-736. The forward step is emitted BEFORE any write (no-leakage).
//
// NOTE: HIERARCHICAL_ELO_ENABLED is read as the LIVE const inside replay.ts (fixed A2
// background — both SRT variants share it). It is currently `true`, so the A2-global
// anchors below assert the flag-on behaviour, matching production.

import { describe, expect, it } from 'vitest';
import {
  ELO_K_GLOBAL,
  HIERARCHICAL_ELO_ENABLED,
  conjunctiveItemProb,
  expectedScore,
} from '@/core/theta';
import {
  type ThetaGridPosterior,
  gridUpdate,
  posteriorMean,
  uniformPrior,
} from '@/core/theta-grid';
import { type ReplayAttempt, replayTheta } from './replay';

function attempt(
  partial: Partial<ReplayAttempt> & Pick<ReplayAttempt, 'knowledgeIds'>,
): ReplayAttempt {
  return {
    scoredKnowledgeId:
      partial.scoredKnowledgeId !== undefined
        ? partial.scoredKnowledgeId
        : partial.knowledgeIds.length === 1
          ? partial.knowledgeIds[0]
          : null,
    domainByKc:
      partial.domainByKc ?? Object.fromEntries(partial.knowledgeIds.map((k) => [k, null])),
    outcome: partial.outcome ?? 1,
    difficulty: partial.difficulty ?? 3,
    b: partial.b ?? 0,
    bWeight: partial.bWeight ?? 1,
    responseTimeMs: partial.responseTimeMs ?? null,
    createdAt: partial.createdAt ?? 0,
    eventId: partial.eventId ?? 'e',
    knowledgeIds: partial.knowledgeIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A4 (YUK-436) GRID TRACK — pure-additive shadow grid-Bayes posterior replay.
// The fold faithfulness vs production lives in replay.fixture.db.test.ts; these unit
// tests pin the no-leakage ordering, the flag-off regression, the cold-start symmetry,
// the PRE-attempt θ_global anchor, and the single-KC-only gate.
// ─────────────────────────────────────────────────────────────────────────────
describe('replayTheta — A4 grid track (gridEnabled)', () => {
  it('SELF-CONSISTENCY oracle: gridPredictedP per step = expectedScore(posteriorMean(priorBeforeStep), b) [no-leakage, pre-fold posterior]', () => {
    // domain null → θ_global = 0 → bPrime = b throughout; the grid runs over the raw offset.
    const b = 0.5;
    const outcomes: (0 | 1)[] = [1, 0, 1, 1];
    const attempts = outcomes.map((o, i) =>
      attempt({
        knowledgeIds: ['k'],
        domainByKc: { k: null },
        outcome: o,
        b,
        eventId: `e${i}`,
        createdAt: i,
      }),
    );
    const r = replayTheta(attempts, { srtEnabled: false, gridEnabled: true });

    // Independently fold with the theta-grid primitives, recomputing the expected forward
    // prediction from the PRE-fold posterior at each step.
    let prior: ThetaGridPosterior = uniformPrior();
    for (let i = 0; i < outcomes.length; i++) {
      const expectedPred = expectedScore(posteriorMean(prior), b); // θ_global=0 → +0
      expect(r.steps[i].gridPredictedP as number).toBeCloseTo(expectedPred, 12);
      prior = gridUpdate(prior, b, outcomes[i]); // bPrime = b − 0
    }
    // final posterior matches the independent fold elementwise.
    const finalPost = r.finalState.thetaGridByKc.get('k') as ThetaGridPosterior;
    expect(finalPost.evidence).toBe(outcomes.length);
    for (let j = 0; j < finalPost.probs.length; j++) {
      expect(finalPost.probs[j]).toBeCloseTo(prior.probs[j], 12);
    }
  });

  it('gridPredictedP uses the PRE-attempt θ_global (not post): 2nd same-domain KC reflects θ_global accumulated from the 1st attempt', () => {
    expect(HIERARCHICAL_ELO_ENABLED).toBe(true); // anchor assumes live A2 flag on
    const r = replayTheta(
      [
        // 1st: single-KC k1 in domain d1, correct, b=0 → drifts θ_global(d1) to ELO_K_GLOBAL*0.5.
        attempt({
          knowledgeIds: ['k1'],
          domainByKc: { k1: 'd1' },
          outcome: 1,
          b: 0,
          eventId: 'e1',
          createdAt: 1,
        }),
        // 2nd: fresh single-KC k2 in the SAME domain d1, b=0. Its grid forward prediction must
        // use the PRE-attempt θ_global = 0.024 (post-1st), NOT the post-2nd value (0.048).
        attempt({
          knowledgeIds: ['k2'],
          domainByKc: { k2: 'd1' },
          outcome: 1,
          b: 0,
          eventId: 'e2',
          createdAt: 2,
        }),
      ],
      { srtEnabled: false, gridEnabled: true },
    );
    const preGlobal = ELO_K_GLOBAL * 0.5; // 0.024
    // k2 fresh → posteriorMean(uniform)=0 → gridPredictedP = expectedScore(preGlobal + 0, 0).
    expect(r.steps[1].gridPredictedP as number).toBeCloseTo(expectedScore(preGlobal, 0), 12);
    expect(r.steps[1].gridPredictedP as number).toBeCloseTo(expectedScore(0.024, 0), 12);
    // sanity: NOT the post-attempt global (0.048).
    expect(r.steps[1].gridPredictedP as number).not.toBeCloseTo(expectedScore(0.048, 0), 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YUK-463 MULTI-KC FORWARD SCORING (multiKcScoring) — a multi-KC attempt emits a
// conjunctive item-level forward prediction (∏ σ(θ_j − b)) so the V-A1-fwd gate can fold
// it into the scored pool. These pin the flag-off byte-identical anchor, the conjunctive
// value + sorted combo key, the single-KC no-double-scoring rule, and no-leakage.
// ─────────────────────────────────────────────────────────────────────────────
describe('replayTheta — YUK-463 multi-KC forward scoring (multiKcScoring)', () => {
  it('flag ON → itemPredictedP uses the PRE-attempt θ (no-leakage): later multi-KC step reflects accumulated θ_KC', () => {
    const b = 0;
    const r = replayTheta(
      [
        // single-KC 'a' correct, cold → θ_KC(a) = eloK(0)*credit = 0.4*0.5 = 0.2.
        attempt({ knowledgeIds: ['a'], outcome: 1, b, eventId: 'e1', createdAt: 1 }),
        // multi-KC [a,c]: itemPredictedP must use the POST-1st θ_KC(a)=0.2 (pre-2nd), c cold=0.
        attempt({
          knowledgeIds: ['a', 'c'],
          scoredKnowledgeId: null,
          outcome: 1,
          b,
          responseTimeMs: 5000,
          eventId: 'e2',
          createdAt: 2,
        }),
      ],
      { srtEnabled: false, multiKcScoring: true },
    );
    expect(r.steps[1].itemPredictedP as number).toBeCloseTo(conjunctiveItemProb([0.2, 0], b), 12);
  });
});
