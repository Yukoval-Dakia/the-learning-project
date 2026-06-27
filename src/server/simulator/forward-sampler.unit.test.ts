import { PFA_GAMMA, PFA_RHO, pLearned } from '@/core/pfa';
import { expectedScore, srtOutcome } from '@/core/theta';
import { mulberry32 } from '@/server/calibration/rng';
import { describe, expect, it } from 'vitest';
import {
  type SelectionPolicy,
  type SimScenario,
  assertValidScenario,
  rolloutLearner,
  roundRobinPolicy,
  seededRollout,
} from './forward-sampler';

// ──────────────────────────────────────────────────────────────────────────────
// A14/A15 forward sampler (YUK-446 / YUK-447) — pure, seeded, deterministic.
// Verifies: determinism, exact reuse of the live IRT/PFA/SRT probabilities, KG
// prereq gating, PFA learning dynamics, estimator-belief tracking, validation.
// ──────────────────────────────────────────────────────────────────────────────

const irtScenario = (overrides: Partial<SimScenario> = {}): SimScenario => ({
  responseModel: 'irt',
  kcs: [{ id: 'k1', trueTheta: 0.5 }],
  items: [{ id: 'i1', b: 0, kcIds: ['k1'], difficulty: 3 }],
  ...overrides,
});

describe('forward-sampler — determinism (seeded)', () => {
  it('same seed + same scenario + same policy ⇒ byte-identical trajectory', () => {
    const scenario = irtScenario({
      kcs: [
        { id: 'k1', trueTheta: 0.3 },
        { id: 'k2', trueTheta: -0.4 },
      ],
      items: [
        { id: 'i1', b: 0.1, kcIds: ['k1'], difficulty: 2 },
        { id: 'i2', b: -0.2, kcIds: ['k2'], difficulty: 4 },
        { id: 'i3', b: 0.5, kcIds: ['k1', 'k2'], difficulty: 5 },
      ],
    });
    const a = seededRollout(scenario, { horizon: 30, sampleResponseTime: true }, 12345);
    const b = seededRollout(scenario, { horizon: 30, sampleResponseTime: true }, 12345);
    expect(a).toStrictEqual(b);
  });

  it('injected rng stream matches the seeded convenience wrapper', () => {
    const scenario = irtScenario();
    const viaSeed = seededRollout(scenario, { horizon: 10 }, 7);
    const viaRng = rolloutLearner(scenario, { horizon: 10 }, mulberry32(7));
    expect(viaRng).toStrictEqual(viaSeed);
  });

  it('different seeds can produce different outcome sequences', () => {
    const scenario = irtScenario({ kcs: [{ id: 'k1', trueTheta: 0 }] }); // p≈0.5, max entropy
    const seqs = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = seededRollout(scenario, { horizon: 20 }, seed);
      seqs.add(r.steps.map((s) => s.outcome).join(''));
    }
    expect(seqs.size).toBeGreaterThan(1);
  });
});

describe('forward-sampler — reuses the LIVE probabilities (no re-derivation)', () => {
  it('IRT P(correct) at step 0 equals expectedScore(trueTheta, b) exactly', () => {
    const scenario = irtScenario({
      kcs: [{ id: 'k1', trueTheta: 0.7 }],
      items: [{ id: 'i1', b: 0.2, kcIds: ['k1'] }],
    });
    const r = seededRollout(scenario, { horizon: 1 }, 99);
    expect(r.steps[0].pCorrect).toBe(expectedScore(0.7, 0.2));
  });

  it('IRT multi-KC P(correct) is the conjunctive product of expectedScore', () => {
    const scenario = irtScenario({
      kcs: [
        { id: 'k1', trueTheta: 0.4 },
        { id: 'k2', trueTheta: -0.1 },
      ],
      items: [{ id: 'i1', b: 0.3, kcIds: ['k1', 'k2'] }],
    });
    const r = seededRollout(scenario, { horizon: 1 }, 3);
    expect(r.steps[0].pCorrect).toBe(expectedScore(0.4, 0.3) * expectedScore(-0.1, 0.3));
  });

  it('PFA P(correct) at step 0 equals pLearned(beta, γ, ρ, 0, 0) exactly', () => {
    const scenario = irtScenario({
      responseModel: 'pfa',
      kcs: [{ id: 'k1', trueTheta: 0, beta: 0.5 }],
      items: [{ id: 'i1', b: 0.9, kcIds: ['k1'] }],
    });
    const r = seededRollout(scenario, { horizon: 1 }, 5);
    // beta is the KC β (0.5), NOT the item b — the live "representative b as β" convention.
    expect(r.steps[0].pCorrect).toBe(pLearned(0.5, PFA_GAMMA, PFA_RHO, 0, 0));
  });

  it('PFA falls back to the item b as β when the KC β is unset', () => {
    const scenario = irtScenario({
      responseModel: 'pfa',
      kcs: [{ id: 'k1', trueTheta: 0 }], // no beta
      items: [{ id: 'i1', b: 0.6, kcIds: ['k1'] }],
    });
    const r = seededRollout(scenario, { horizon: 1 }, 5);
    expect(r.steps[0].pCorrect).toBe(pLearned(0.6, PFA_GAMMA, PFA_RHO, 0, 0));
  });

  it('RT path produces srtOutcome from resolveSrtTimeLimit + the sampled time', () => {
    const scenario = irtScenario();
    const r = seededRollout(scenario, { horizon: 1, sampleResponseTime: true }, 11);
    const step = r.steps[0];
    const rt = step.responseTimeSec;
    if (rt === null) throw new Error('expected a sampled response time');
    expect(step.srtOutcome).not.toBeNull();
    // difficulty 3 → d=30; reconstruct the exact srtOutcome from the recorded RT.
    expect(step.srtOutcome).toBe(srtOutcome(step.outcome === 1, 30, rt));
  });

  it('RT is null when sampling is disabled (default)', () => {
    const r = seededRollout(irtScenario(), { horizon: 3 }, 1);
    for (const s of r.steps) {
      expect(s.responseTimeSec).toBeNull();
      expect(s.srtOutcome).toBeNull();
    }
  });
});

describe('forward-sampler — KG prereq forward model', () => {
  it('an unmet prerequisite depresses P(correct) by prereqPenalty (else inert)', () => {
    // k2 requires k1; the learner is weak on k1 (trueTheta well below the 0.5 mastery
    // threshold at b=0 → σ(-2)≈0.12 < 0.5 → prereq unmet).
    const base: SimScenario = {
      responseModel: 'irt',
      masteryThreshold: 0.5,
      kcs: [
        { id: 'k1', trueTheta: -2 },
        { id: 'k2', trueTheta: 0.8, prereqIds: ['k1'] },
      ],
      items: [{ id: 'i1', b: 0, kcIds: ['k2'] }],
    };
    const inert = seededRollout({ ...base, prereqPenalty: 0 }, { horizon: 1 }, 1);
    const gated = seededRollout({ ...base, prereqPenalty: 1.5 }, { horizon: 1 }, 1);
    expect(inert.steps[0].pCorrect).toBe(expectedScore(0.8, 0));
    expect(gated.steps[0].pCorrect).toBe(expectedScore(0.8 - 1.5, 0));
    expect(gated.steps[0].pCorrect).toBeLessThan(inert.steps[0].pCorrect);
  });

  it('a met prerequisite leaves P(correct) unpenalized', () => {
    // k1 strong (σ(2)≈0.88 ≥ 0.5 → mastered) → no penalty even with a large prereqPenalty.
    const scenario: SimScenario = {
      responseModel: 'irt',
      prereqPenalty: 3,
      kcs: [
        { id: 'k1', trueTheta: 2 },
        { id: 'k2', trueTheta: 0.5, prereqIds: ['k1'] },
      ],
      items: [{ id: 'i1', b: 0, kcIds: ['k2'] }],
    };
    const r = seededRollout(scenario, { horizon: 1 }, 1);
    expect(r.steps[0].pCorrect).toBe(expectedScore(0.5, 0));
  });
});

describe('forward-sampler — PFA learning dynamics', () => {
  it('a high-ability learner accrues mastery: trueCompetence rises above the cold 0.5', () => {
    const scenario: SimScenario = {
      responseModel: 'pfa',
      kcs: [{ id: 'k1', trueTheta: 0, beta: -1.5 }], // easy KC → mostly correct → success accrues
      items: [{ id: 'i1', b: -1.5, kcIds: ['k1'] }],
    };
    const r = seededRollout(scenario, { horizon: 40 }, 2);
    const successes = r.steps.filter((s) => s.outcome === 1).length;
    expect(successes).toBeGreaterThan(20); // easy item → majority correct
    // PFA competence grows with net successes (started at pLearned(β,γ,ρ,0,0)).
    const cold = pLearned(-1.5, PFA_GAMMA, PFA_RHO, 0, 0);
    expect(r.trueCompetence.k1).toBeGreaterThan(cold);
    // p(correct) on the LAST step should exceed the first (learning trajectory).
    const last = r.steps[r.steps.length - 1];
    expect(last.pCorrect).toBeGreaterThan(r.steps[0].pCorrect);
  });
});

describe('forward-sampler — estimator belief (live θ̂ credit path)', () => {
  it('θ̂ precision strictly increases (SE shrinks) and attempts count up', () => {
    const r = seededRollout(irtScenario(), { horizon: 8 }, 4);
    const belief = r.finalBelief.k1;
    expect(belief.attempts).toBe(8);
    // SE = 1/√precision, precision starts at 1 and only accumulates → SE strictly < 1.
    expect(belief.se).toBeLessThan(1);
    expect(belief.pLearned).toBeGreaterThan(0);
    expect(belief.pLearned).toBeLessThan(1);
  });

  it('beliefAfter only carries the KCs the item taxed', () => {
    const scenario = irtScenario({
      kcs: [
        { id: 'k1', trueTheta: 0 },
        { id: 'k2', trueTheta: 0 },
      ],
      items: [{ id: 'i1', b: 0, kcIds: ['k1'] }], // only taxes k1
    });
    const r = seededRollout(scenario, { horizon: 1 }, 1);
    expect(Object.keys(r.steps[0].beliefAfter)).toEqual(['k1']);
    // but finalBelief reports every KC.
    expect(Object.keys(r.finalBelief).sort()).toEqual(['k1', 'k2']);
  });
});

describe('forward-sampler — policy seam', () => {
  it('default round-robin cycles through the item bank in order', () => {
    const scenario = irtScenario({
      kcs: [{ id: 'k1', trueTheta: 0 }],
      items: [
        { id: 'i1', b: 0, kcIds: ['k1'] },
        { id: 'i2', b: 0, kcIds: ['k1'] },
        { id: 'i3', b: 0, kcIds: ['k1'] },
      ],
    });
    const r = seededRollout(scenario, { horizon: 7 }, 1);
    expect(r.steps.map((s) => s.itemIndex)).toEqual([0, 1, 2, 0, 1, 2, 0]);
  });

  it('a custom policy can condition on belief + history and stop early (null)', () => {
    // Stop as soon as 2 steps have been produced.
    const stopAfter2: SelectionPolicy = (ctx) => (ctx.history.length >= 2 ? null : 0);
    const r = seededRollout(
      { ...irtScenario(), kcs: [{ id: 'k1', trueTheta: 0 }] },
      { horizon: 100, policy: stopAfter2 },
      1,
    );
    expect(r.steps).toHaveLength(2);
  });

  it('roundRobinPolicy returns null for an empty item bank', () => {
    expect(
      roundRobinPolicy({ step: 0, horizon: 1, items: [], belief: {}, history: [], draw: 0 }),
    ).toBeNull();
  });

  it('throws if a policy returns an out-of-range item index', () => {
    const bad: SelectionPolicy = () => 99;
    expect(() => seededRollout(irtScenario(), { horizon: 1, policy: bad }, 1)).toThrow(
      /out-of-range itemIndex/,
    );
  });
});

describe('forward-sampler — validation guards', () => {
  it('horizon 0 yields an empty trajectory (no draws consumed)', () => {
    const r = seededRollout(irtScenario(), { horizon: 0 }, 1);
    expect(r.steps).toHaveLength(0);
    expect(r.finalBelief.k1.attempts).toBe(0);
  });

  it('rejects a non-integer / negative horizon', () => {
    expect(() => seededRollout(irtScenario(), { horizon: -1 }, 1)).toThrow(/horizon/);
    expect(() => seededRollout(irtScenario(), { horizon: 2.5 }, 1)).toThrow(/horizon/);
  });

  it('rejects empty KCs / items', () => {
    expect(() => assertValidScenario({ kcs: [], items: [] })).toThrow(/no KCs/);
    expect(() => assertValidScenario({ kcs: [{ id: 'k1', trueTheta: 0 }], items: [] })).toThrow(
      /no items/,
    );
  });

  it('rejects an item referencing an unknown KC', () => {
    expect(() =>
      assertValidScenario({
        kcs: [{ id: 'k1', trueTheta: 0 }],
        items: [{ id: 'i1', b: 0, kcIds: ['ghost'] }],
      }),
    ).toThrow(/unknown KC/);
  });

  it('rejects a prereq edge to an unknown KC', () => {
    expect(() =>
      assertValidScenario({
        kcs: [{ id: 'k1', trueTheta: 0, prereqIds: ['ghost'] }],
        items: [{ id: 'i1', b: 0, kcIds: ['k1'] }],
      }),
    ).toThrow(/prereq 'ghost' is not a known KC/);
  });

  it('rejects a duplicate KC id and a non-finite trueTheta', () => {
    expect(() =>
      assertValidScenario({
        kcs: [
          { id: 'k1', trueTheta: 0 },
          { id: 'k1', trueTheta: 1 },
        ],
        items: [{ id: 'i1', b: 0, kcIds: ['k1'] }],
      }),
    ).toThrow(/duplicate KC id/);
    expect(() =>
      assertValidScenario({
        kcs: [{ id: 'k1', trueTheta: Number.NaN }],
        items: [{ id: 'i1', b: 0, kcIds: ['k1'] }],
      }),
    ).toThrow(/trueTheta must be finite/);
  });

  it('rejects a negative prereqPenalty', () => {
    expect(() =>
      assertValidScenario({
        kcs: [{ id: 'k1', trueTheta: 0 }],
        items: [{ id: 'i1', b: 0, kcIds: ['k1'] }],
        prereqPenalty: -1,
      }),
    ).toThrow(/prereqPenalty must be a finite number >= 0/);
  });
});
