// TASK 6 — PURE in-memory θ̂ replay engine. Re-derives the per-KC θ̂ trajectory from an
// ordered attempt log under a SRT flag VARIANT, reusing the EXACT production primitives
// from @/core/theta (expectedScore / eloK / conjunctiveCredits / conjunctiveCreditsContinuous
// / srtOutcome / resolveSrtTimeLimit / ELO_K_GLOBAL). Hand-computed anchors mirror
// state.ts:453-736. The forward step is emitted BEFORE any write (no-leakage).
//
// NOTE: HIERARCHICAL_ELO_ENABLED is read as the LIVE const inside replay.ts (fixed A2
// background — both SRT variants share it). It is currently `true`, so the A2-global
// anchors below assert the flag-on behaviour, matching production.

import { ELO_K_GLOBAL, HIERARCHICAL_ELO_ENABLED, expectedScore } from '@/core/theta';
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
