// TASK 6 — PURE in-memory θ̂ replay engine. Re-derives the per-KC θ̂ trajectory from an
// ordered attempt log under a SRT flag VARIANT, reusing the EXACT production primitives
// from @/core/theta (expectedScore / eloK / conjunctiveCredits / conjunctiveCreditsContinuous
// / srtOutcome / resolveSrtTimeLimit / ELO_K_GLOBAL). Hand-computed anchors mirror
// state.ts:453-736. The forward step is emitted BEFORE any write (no-leakage).
//
// NOTE: HIERARCHICAL_ELO_ENABLED is read as the LIVE const inside replay.ts (fixed A2
// background — both SRT variants share it). It is currently `true`, so the A2-global
// anchors below assert the flag-on behaviour, matching production.

import { ELO_K_GLOBAL, HIERARCHICAL_ELO_ENABLED, SRT_RT_MIN_N, expectedScore } from '@/core/theta';
import {
  type ThetaGridPosterior,
  gridUpdate,
  posteriorMean,
  uniformPrior,
} from '@/core/theta-grid';
import { describe, expect, it } from 'vitest';
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

describe('replayTheta — pure θ̂ replay', () => {
  it('single binary correct, cold, no domain, b=0 → predictedP=0.5, θ_KC→0.2', () => {
    const r = replayTheta([attempt({ knowledgeIds: ['k'], outcome: 1, b: 0 })], {
      srtEnabled: false,
    });
    expect(r.steps).toHaveLength(1);
    const s = r.steps[0];
    expect(s.scoredKnowledgeId).toBe('k');
    expect(s.preAttemptEffectiveTheta).toBe(0);
    expect(s.predictedP).toBeCloseTo(0.5, 12); // σ(0)
    expect(s.hasRt).toBe(false);
    // credit = 1 - 0.5 = 0.5; k = eloK(0) = 0.4; θ_KC = 0 + 0.4*1*0.5 = 0.2
    // The post-θ is not directly exposed; assert via a second attempt's pre-θ below.
  });

  it('two attempts same KC: 2nd pre-θ = 0.2 → predictedP = σ(0.2) (uses θ_{t-1} not θ_t)', () => {
    const r = replayTheta(
      [
        attempt({ knowledgeIds: ['k'], outcome: 1, b: 0, eventId: 'e1', createdAt: 1 }),
        attempt({ knowledgeIds: ['k'], outcome: 1, b: 0, eventId: 'e2', createdAt: 2 }),
      ],
      { srtEnabled: false },
    );
    // Pure float64 replay → exact hand-computed value (the `real`-column persistence
    // quantization only applies in the live DB path, validated by the fixture's ~1e-6 tol).
    expect(r.steps[1].preAttemptEffectiveTheta).toBeCloseTo(0.2, 12);
    expect(r.steps[1].predictedP).toBeCloseTo(expectedScore(0.2, 0), 12);
  });

  it('SRT slow-correct moves θ LESS than binary (direction)', () => {
    // rt=40000ms (40s) > d(3)=30s → srtOutcome(true,30,40)=0.575 (floored) → credit 0.075
    // binary credit = 0.5. So SRT post-θ < binary post-θ. Compare via a following 2nd attempt.
    const seq = (srt: boolean) =>
      replayTheta(
        [
          attempt({
            knowledgeIds: ['k'],
            outcome: 1,
            b: 0,
            responseTimeMs: 40000,
            difficulty: 3,
            eventId: 'e1',
            createdAt: 1,
          }),
          attempt({
            knowledgeIds: ['k'],
            outcome: 1,
            b: 0,
            responseTimeMs: null,
            eventId: 'e2',
            createdAt: 2,
          }),
        ],
        { srtEnabled: srt },
      );
    const srtRun = seq(true);
    const binaryRun = seq(false);
    // 2nd attempt's pre-θ = post-θ of the 1st. SRT 1st credit (0.075) < binary (0.5).
    expect(srtRun.steps[1].preAttemptEffectiveTheta).toBeLessThan(
      binaryRun.steps[1].preAttemptEffectiveTheta as number,
    );
    // also the 1st step records hasRt=true under both variants
    expect(srtRun.steps[0].hasRt).toBe(true);
  });

  it('A2 global inheritance: 2nd KC of same domain inherits θ_global=0.024', () => {
    expect(HIERARCHICAL_ELO_ENABLED).toBe(true); // guard: anchor assumes live flag on
    const r = replayTheta(
      [
        attempt({
          knowledgeIds: ['k1'],
          domainByKc: { k1: 'd1' },
          outcome: 1,
          b: 0,
          eventId: 'e1',
          createdAt: 1,
        }),
        attempt({
          knowledgeIds: ['k2'],
          domainByKc: { k2: 'd1' },
          outcome: 1,
          b: 0,
          eventId: 'e2',
          createdAt: 2,
        }),
      ],
      { srtEnabled: false },
    );
    // 1st: credit 0.5 → θ_global('d1') = ELO_K_GLOBAL*1*0.5 = 0.024
    // 2nd (fresh KC k2, θ_KC=0): pre-effective = 0 + 0.024.
    expect(r.steps[1].preAttemptEffectiveTheta).toBeCloseTo(ELO_K_GLOBAL * 0.5, 12);
    expect(r.steps[1].preAttemptEffectiveTheta).toBeCloseTo(0.024, 12);
  });

  it('bWeight=0.3 down-weights the update (θ_KC → 0.06)', () => {
    const r = replayTheta(
      [
        attempt({
          knowledgeIds: ['k'],
          outcome: 1,
          b: 0,
          bWeight: 0.3,
          eventId: 'e1',
          createdAt: 1,
        }),
        attempt({
          knowledgeIds: ['k'],
          outcome: 1,
          b: 0,
          bWeight: 0.3,
          eventId: 'e2',
          createdAt: 2,
        }),
      ],
      { srtEnabled: false },
    );
    // θ_KC = 0 + 0.4*0.3*0.5 = 0.06.
    expect(r.steps[1].preAttemptEffectiveTheta).toBeCloseTo(0.06, 12);
  });

  it('multi-KC step is NOT forward-scorable but still advances each θ_KC', () => {
    const r = replayTheta(
      [
        // multi-KC attempt: not scorable, but advances θ_KC for both 'a' and 'b'
        attempt({
          knowledgeIds: ['a', 'b'],
          scoredKnowledgeId: null,
          outcome: 1,
          b: 0,
          eventId: 'e1',
          createdAt: 1,
        }),
        // single-KC follow-up on 'a' — its pre-θ must reflect the multi-KC update above
        attempt({ knowledgeIds: ['a'], outcome: 1, b: 0, eventId: 'e2', createdAt: 2 }),
      ],
      { srtEnabled: false },
    );
    expect(r.steps[0].scoredKnowledgeId).toBeNull();
    expect(r.steps[0].predictedP).toBeNull();
    expect(r.steps[0].preAttemptEffectiveTheta).toBeNull();
    // 'a' advanced in the multi-KC step → 2nd step's pre-θ > 0 (the conjunctive update ran)
    expect(r.steps[1].preAttemptEffectiveTheta).toBeGreaterThan(0);
  });

  it('empty attempts → empty steps', () => {
    const r = replayTheta([], { srtEnabled: true });
    expect(r.steps).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4 (YUK-436) GRID TRACK — pure-additive shadow grid-Bayes posterior replay.
// The fold faithfulness vs production lives in replay.fixture.db.test.ts; these unit
// tests pin the no-leakage ordering, the flag-off regression, the cold-start symmetry,
// the PRE-attempt θ_global anchor, and the single-KC-only gate.
// ─────────────────────────────────────────────────────────────────────────────
describe('replayTheta — A4 grid track (gridEnabled)', () => {
  it('flag OFF (gridEnabled absent/false) → every gridPredictedP null + empty thetaGridByKc', () => {
    const r = replayTheta(
      [
        attempt({ knowledgeIds: ['k'], outcome: 1, b: 0.3, eventId: 'e1', createdAt: 1 }),
        attempt({ knowledgeIds: ['k'], outcome: 0, b: 0.3, eventId: 'e2', createdAt: 2 }),
      ],
      { srtEnabled: false }, // gridEnabled absent → defaults false
    );
    for (const s of r.steps) expect(s.gridPredictedP).toBeNull();
    expect(r.finalState.thetaGridByKc.size).toBe(0);

    // explicit gridEnabled:false is identical.
    const r2 = replayTheta([attempt({ knowledgeIds: ['k'], outcome: 1, b: 0.3 })], {
      srtEnabled: false,
      gridEnabled: false,
    });
    expect(r2.steps[0].gridPredictedP).toBeNull();
    expect(r2.finalState.thetaGridByKc.size).toBe(0);
  });

  it('cold-start symmetric: first single-KC scorable attempt (θ_global 0) → gridPredictedP = σ(0 − b) = expectedScore(0, b)', () => {
    const b = 0.7;
    const r = replayTheta(
      [attempt({ knowledgeIds: ['k'], outcome: 1, b, domainByKc: { k: null } })],
      {
        srtEnabled: false,
        gridEnabled: true,
      },
    );
    // posteriorMean(uniformPrior()) === 0 by grid symmetry, θ_global=0 → expectedScore(0, b).
    expect(posteriorMean(uniformPrior())).toBeCloseTo(0, 12);
    expect(r.steps[0].gridPredictedP).toBeCloseTo(expectedScore(0, b), 12);
    // one fold persisted on the scored KC.
    const post = r.finalState.thetaGridByKc.get('k');
    expect(post).toBeDefined();
    expect((post as ThetaGridPosterior).evidence).toBe(1);
  });

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

  it('multi-KC steps: gridPredictedP null + no fold, while interleaved single-KC steps still fold', () => {
    const r = replayTheta(
      [
        // multi-KC attempt: NOT grid-scorable.
        attempt({
          knowledgeIds: ['a', 'b'],
          scoredKnowledgeId: null,
          domainByKc: { a: null, b: null },
          outcome: 1,
          b: 0,
          eventId: 'e1',
          createdAt: 1,
        }),
        // single-KC follow-up on 'a' → grid folds for 'a'.
        attempt({
          knowledgeIds: ['a'],
          domainByKc: { a: null },
          outcome: 1,
          b: 0,
          eventId: 'e2',
          createdAt: 2,
        }),
      ],
      { srtEnabled: false, gridEnabled: true },
    );
    expect(r.steps[0].gridPredictedP).toBeNull(); // multi-KC → no grid forward
    expect(r.steps[1].gridPredictedP).not.toBeNull(); // single-KC → grid forward emitted
    // only 'a' got a grid fold (the single-KC step); 'b' never appears as a scored KC.
    expect(r.finalState.thetaGridByKc.has('a')).toBe(true);
    expect(r.finalState.thetaGridByKc.has('b')).toBe(false);
    expect((r.finalState.thetaGridByKc.get('a') as ThetaGridPosterior).evidence).toBe(1);
  });

  // Faithfulness: the grid FOLD gate is production's `states.length === 1` over the deduped
  // REFERENCED set (kcs.length===1, state.ts:815), DECOUPLED from the question's single-KC
  // cardinality (scoredKnowledgeId, audit-calibration.ts:347). They coincide for canonical
  // single-KC items but DIVERGE on the paper path — these two cases pin that decoupling (the
  // pre-fix code gated the fold on scoredKnowledgeId and would FAIL both).
  it('1c: fold gate keys off deduped referenced set (kcs.length), NOT scoredKnowledgeId [paper-path divergence]', () => {
    // Case 1 — single-KC QUESTION but the referenced set has 2 KCs (slot added a secondary):
    //   production states.length===2 → NO grid fold; yet scoredKnowledgeId='a' is forward-scorable.
    const case1 = replayTheta(
      [attempt({ knowledgeIds: ['a', 'b'], scoredKnowledgeId: 'a', b: 0, outcome: 1 })],
      { srtEnabled: false, gridEnabled: true },
    );
    expect(case1.steps[0].gridPredictedP).not.toBeNull(); // forward-scorable (single-KC question)
    expect(case1.finalState.thetaGridByKc.size).toBe(0); // but NO fold (deduped set len 2)

    // Case 2 — multi-KC QUESTION but only ONE referenced KC (slot referenced a single KC):
    //   production states.length===1 → grid FOLDS 'a'; yet scoredKnowledgeId=null → NO grid forward.
    const case2 = replayTheta(
      [attempt({ knowledgeIds: ['a'], scoredKnowledgeId: null, b: 0, outcome: 1 })],
      { srtEnabled: false, gridEnabled: true },
    );
    expect(case2.steps[0].gridPredictedP).toBeNull(); // not forward-scorable (multi-KC question)
    expect(case2.finalState.thetaGridByKc.has('a')).toBe(true); // FOLD happened (deduped set len 1)
    expect((case2.finalState.thetaGridByKc.get('a') as ThetaGridPosterior).evidence).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1 (YUK-450) — Fisher-conditioned time weight variant (opts.fisherWeightEnabled).
// Default false → byte-identical. On → timeWeight = 4·pItem·(1−pItem) at the seam, fading
// the time term at extreme p (and taming the over-harsh "easy item answered slow" credit).
// ─────────────────────────────────────────────────────────────────────────────
describe('replayTheta — Fisher time-weight variant (YUK-450)', () => {
  it('fisherWeightEnabled default (off) is byte-identical to omitting it', () => {
    const seq = [
      attempt({ knowledgeIds: ['k'], outcome: 1, b: -1, responseTimeMs: 5000, createdAt: 1 }),
      attempt({ knowledgeIds: ['k'], outcome: 0, b: -1, responseTimeMs: 40000, createdAt: 2 }),
    ];
    const off = replayTheta(seq, { srtEnabled: true });
    const explicitOff = replayTheta(seq, { srtEnabled: true, fisherWeightEnabled: false });
    expect(explicitOff.finalState.thetaKc.get('k')).toBe(off.finalState.thetaKc.get('k'));
  });

  it('on EASY item (p≈1) tames the over-harsh slow-correct negative credit (副作用 treatment)', () => {
    // b=-4 → cold p=σ(4)≈0.982; slow-correct (40s > d=30s → floored srtOutcome 0.575).
    // OFF: credit = 0.575 − 0.982 < 0 → answering CORRECTLY drops θ (the over-harsh effect).
    // ON:  w = 4·0.982·0.018 ≈ 0.07 → srtOutcome → ~0.97 → credit ≈ 0 → θ barely moves.
    const seq = [attempt({ knowledgeIds: ['k'], outcome: 1, b: -4, responseTimeMs: 40000 })];
    const off = replayTheta(seq, { srtEnabled: true, fisherWeightEnabled: false });
    const on = replayTheta(seq, { srtEnabled: true, fisherWeightEnabled: true });
    const thetaOff = off.finalState.thetaKc.get('k') ?? 0;
    const thetaOn = on.finalState.thetaKc.get('k') ?? 0;
    expect(thetaOff).toBeLessThan(0); // over-harsh: correct answer pulled θ down
    expect(thetaOn).toBeGreaterThan(thetaOff); // weight tames it (less negative)
    expect(thetaOn).toBeGreaterThan(-0.05); // near-zero movement at extreme p
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1 (YUK-449) — per-KC rolling RT quantile d variant (opts.dFromQuantile). Default false →
// population seed → byte-identical. On → d = quantile of the PRIMARY KC's PRIOR correct RTs
// once ≥ SRT_RT_MIN_N samples accrue; below that the seed (cold-start fallback). CAUSAL: only
// prior attempts inform d (this attempt's RT is pushed AFTER its own update) → no leakage.
// ─────────────────────────────────────────────────────────────────────────────
describe('replayTheta — quantile-d variant (YUK-449)', () => {
  it('dFromQuantile default (off) is byte-identical to omitting it', () => {
    const seq = [
      attempt({ knowledgeIds: ['k'], outcome: 1, b: 0, responseTimeMs: 3000, createdAt: 1 }),
      attempt({ knowledgeIds: ['k'], outcome: 1, b: 0, responseTimeMs: 4000, createdAt: 2 }),
    ];
    const off = replayTheta(seq, { srtEnabled: true });
    const explicitOff = replayTheta(seq, { srtEnabled: true, dFromQuantile: false });
    expect(explicitOff.finalState.thetaKc.get('k')).toBe(off.finalState.thetaKc.get('k'));
  });

  it('below SRT_RT_MIN_N samples, quantile-d is the population seed (cold-start fallback) — true==false', () => {
    // (MIN_N − 1) correct attempts: the buffer never reaches MIN_N, so every d is the seed,
    // and dFromQuantile true must equal false (no quantile ever engaged).
    const seq = Array.from({ length: SRT_RT_MIN_N - 1 }, (_, i) =>
      attempt({ knowledgeIds: ['k'], outcome: 1, b: 0, responseTimeMs: 1000, createdAt: i + 1 }),
    );
    const off = replayTheta(seq, { srtEnabled: true, dFromQuantile: false });
    const on = replayTheta(seq, { srtEnabled: true, dFromQuantile: true });
    expect(on.finalState.thetaKc.get('k')).toBe(off.finalState.thetaKc.get('k'));
  });

  it('once ≥ SRT_RT_MIN_N prior correct RTs accrue, quantile-d engages and the trajectory diverges', () => {
    // MIN_N fast (1s) correct attempts build a tiny median d (~1s); a later attempt's small d
    // makes a 2s answer "slow" (vs the 30s seed where 2s is "fast") → different credit → θ diverges.
    const seq = [
      ...Array.from({ length: SRT_RT_MIN_N }, (_, i) =>
        attempt({ knowledgeIds: ['k'], outcome: 1, b: 0, responseTimeMs: 1000, createdAt: i + 1 }),
      ),
      attempt({
        knowledgeIds: ['k'],
        outcome: 1,
        b: 0,
        responseTimeMs: 2000,
        createdAt: SRT_RT_MIN_N + 1,
      }),
    ];
    const off = replayTheta(seq, { srtEnabled: true, dFromQuantile: false });
    const on = replayTheta(seq, { srtEnabled: true, dFromQuantile: true });
    expect(on.finalState.thetaKc.get('k')).not.toBe(off.finalState.thetaKc.get('k'));
  });
});
