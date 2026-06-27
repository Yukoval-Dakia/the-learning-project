// TASK 9 — V-A1-fwd keystone gate (PURE): assemble forward clusters from the replay
// engine, run the paired cluster bootstrap, emit a PASS/FAIL/INSUFFICIENT verdict +
// human report. Synthetic end-to-end tests are answer-BY-CONSTRUCTION (the generating
// model determines the verdict; RNG seeded for determinism).

import { HIERARCHICAL_ELO_ENABLED } from '@/core/theta';
import { describe, expect, it } from 'vitest';
import { type ReplayAttempt, replayTheta } from './replay';
import { mulberry32 } from './rng';
import {
  type VA1Result,
  assembleForwardClusters,
  assembleForwardClustersDetailed,
  evaluateVA1Forward,
  formatReport,
} from './v-a1-fwd';

const TEST_CONFIG = {
  effectiveNFloor: 100,
  minKcClusters: 10,
  deltaThreshold: 0.02,
  bootstrapB: 2000,
  maxDegenerateFraction: 0.05,
  multiKcScoring: false,
} as const;

// ── Synthetic single-KC attempt generators ───────────────────────────────────────────
// Each KC gets a time-ordered list of single-KC attempts. The forward predictor uses the
// PRE-attempt θ̂; for SRT to beat binary, RT must carry outcome signal beyond correctness.

let eidCounter = 0;
function nextEid(): string {
  eidCounter += 1;
  return `e${eidCounter}`;
}

function singleKcAttempt(
  kc: string,
  outcome: 0 | 1,
  responseTimeMs: number | null,
  createdAt: number,
  difficulty = 3,
): ReplayAttempt {
  return {
    knowledgeIds: [kc],
    scoredKnowledgeId: kc,
    domainByKc: { [kc]: null },
    outcome,
    difficulty,
    b: 0,
    bWeight: 1,
    responseTimeMs,
    createdAt,
    eventId: nextEid(),
  };
}

// RT carries signal: a learner who is going to answer correctly tends to answer FAST;
// a wrong answer tends to be SLOW. SRT folds RT into θ̂, so the SRT θ̂ trajectory tracks
// the latent "fast=able" structure better than binary, yielding a higher forward AUC.
function signalCluster(kc: string, n: number, seed: number): ReplayAttempt[] {
  const rng = mulberry32(seed);
  const out: ReplayAttempt[] = [];
  for (let t = 0; t < n; t++) {
    // latent ability rises; correctness probability rises with t.
    const pCorrect = 0.35 + 0.5 * (t / Math.max(1, n - 1));
    const correct: 0 | 1 = rng() < pCorrect ? 1 : 0;
    // fast when correct, slow when wrong (RT carries signal). d(3)=30s.
    const rtMs = correct === 1 ? 5000 + rng() * 5000 : 45000 + rng() * 15000;
    out.push(singleKcAttempt(kc, correct, rtMs, t + 1));
  }
  return out;
}

// Null signal: RT is INDEPENDENT of correctness, so SRT cannot beat binary.
function nullCluster(kc: string, n: number, seed: number): ReplayAttempt[] {
  const rng = mulberry32(seed);
  const out: ReplayAttempt[] = [];
  for (let t = 0; t < n; t++) {
    const correct: 0 | 1 = rng() < 0.5 ? 1 : 0;
    const rtMs = 5000 + rng() * 55000; // RT uniform, independent of correctness
    out.push(singleKcAttempt(kc, correct, rtMs, t + 1));
  }
  return out;
}

// Flatten per-KC synthetic lists into ONE time-ordered attempt list (YUK-466: the assembler
// now takes the full interleaved list). These synthetics are all single-KC with domain=null,
// so θ_global never drifts and each KC's θ_KC evolves only on its own (contiguous) attempts →
// concatenating cluster-by-cluster reproduces each KC's trajectory identically.
function flatten(clusters: ReplayAttempt[][]): ReplayAttempt[] {
  return clusters.flat();
}

describe('evaluateVA1Forward — keystone gate', () => {
  it('PASS: ample RT-bearing single-KC data where SRT clearly helps', () => {
    eidCounter = 0;
    const clustersRaw = Array.from({ length: 18 }, (_, i) => signalCluster(`kc${i}`, 14, 5000 + i));
    const clusters = assembleForwardClusters(flatten(clustersRaw));
    const r = evaluateVA1Forward(clusters, {}, mulberry32(42));
    expect(r.verdict).toBe('PASS');
    expect(r.pointDelta).toBeGreaterThan(0.02);
    expect(r.ci.lo).toBeGreaterThan(0);
    expect(r.nWithRt).toBeGreaterThan(0);
    expect(r.kClusters).toBe(18);
    expect(r.effectiveN).toBeGreaterThanOrEqual(100);
  });

  it('INSUFFICIENT (thin): 3 KCs × 2 attempts → effectiveN < 100, pointDelta still reported', () => {
    eidCounter = 0;
    const clustersRaw = Array.from({ length: 3 }, (_, i) => signalCluster(`t${i}`, 2, 100 + i));
    const clusters = assembleForwardClusters(flatten(clustersRaw));
    const r = evaluateVA1Forward(clusters, {}, mulberry32(1));
    expect(r.verdict).toBe('INSUFFICIENT');
    // pointDelta still computed for information (NaN only if a class is missing)
    expect(typeof r.pointDelta).toBe('number');
  });

  it('INSUFFICIENT (one class): all outcomes 1 → both classes required', () => {
    eidCounter = 0;
    const clustersRaw = Array.from({ length: 20 }, (_, i) => {
      const out: ReplayAttempt[] = [];
      for (let t = 0; t < 10; t++) out.push(singleKcAttempt(`o${i}`, 1, 6000, t + 1));
      return out;
    });
    const clusters = assembleForwardClusters(flatten(clustersRaw));
    const r = evaluateVA1Forward(clusters, {}, mulberry32(2));
    expect(r.verdict).toBe('INSUFFICIENT');
    expect(r.reason).toMatch(/class/i);
  });

  it('INSUFFICIENT (RT-less ample): 20 KCs × 10 attempts ALL responseTimeMs=null → nWithRt=0', () => {
    eidCounter = 0;
    const clustersRaw = Array.from({ length: 20 }, (_, i) => {
      const rng = mulberry32(300 + i);
      const out: ReplayAttempt[] = [];
      for (let t = 0; t < 10; t++) {
        const correct: 0 | 1 = rng() < 0.5 ? 1 : 0;
        out.push(singleKcAttempt(`n${i}`, correct, null, t + 1)); // NO RT
      }
      return out;
    });
    const clusters = assembleForwardClusters(flatten(clustersRaw));
    const r = evaluateVA1Forward(clusters, {}, mulberry32(3));
    expect(r.nWithRt).toBe(0);
    expect(r.verdict).toBe('INSUFFICIENT'); // RT-less corpus cannot pass (M4)
  });

  it('FAIL: ample RT but RT independent of correctness (null signal)', () => {
    eidCounter = 0;
    const clustersRaw = Array.from({ length: 18 }, (_, i) => nullCluster(`f${i}`, 14, 7000 + i));
    const clusters = assembleForwardClusters(flatten(clustersRaw));
    const r = evaluateVA1Forward(clusters, {}, mulberry32(11));
    // Clears the floors (ample data) but no SRT advantage → not a PASS. Either FAIL
    // (CI straddles 0 / pointDelta <= threshold).
    expect(r.verdict).toBe('FAIL');
    expect(r.ci.lo).toBeLessThanOrEqual(0);
  });

  it('determinism: same seed → identical verdict + CI', () => {
    eidCounter = 0;
    const clustersRaw = Array.from({ length: 15 }, (_, i) => signalCluster(`d${i}`, 12, 9000 + i));
    const clusters = assembleForwardClusters(flatten(clustersRaw));
    const a = evaluateVA1Forward(clusters, {}, mulberry32(77));
    const b = evaluateVA1Forward(clusters, {}, mulberry32(77));
    expect(a.verdict).toBe(b.verdict);
    expect(a.ci.lo).toBe(b.ci.lo);
    expect(a.ci.hi).toBe(b.ci.hi);
  });

  // ── OCR finding 6: invalid merged config throws (would otherwise produce nonsense). ──
  it('OCR finding 6: bootstrapB<=0 throws', () => {
    eidCounter = 0;
    const clustersRaw = Array.from({ length: 12 }, (_, i) => signalCluster(`c${i}`, 8, 12000 + i));
    const clusters = assembleForwardClusters(flatten(clustersRaw));
    expect(() => evaluateVA1Forward(clusters, { bootstrapB: 0 }, mulberry32(1))).toThrow(
      /bootstrapB/,
    );
  });

  it('OCR finding 6: deltaThreshold<0 throws', () => {
    eidCounter = 0;
    const clusters = assembleForwardClusters(
      flatten(Array.from({ length: 12 }, (_, i) => signalCluster(`c${i}`, 8, 13000 + i))),
    );
    expect(() => evaluateVA1Forward(clusters, { deltaThreshold: -0.5 }, mulberry32(1))).toThrow(
      /deltaThreshold/,
    );
  });

  it('OCR finding 6: minKcClusters=0 throws', () => {
    eidCounter = 0;
    const clusters = assembleForwardClusters(
      flatten(Array.from({ length: 12 }, (_, i) => signalCluster(`c${i}`, 8, 14000 + i))),
    );
    expect(() => evaluateVA1Forward(clusters, { minKcClusters: 0 }, mulberry32(1))).toThrow(
      /minKcClusters/,
    );
  });

  it('OCR finding 6: maxDegenerateFraction>1 throws', () => {
    eidCounter = 0;
    const clusters = assembleForwardClusters(
      flatten(Array.from({ length: 12 }, (_, i) => signalCluster(`c${i}`, 8, 15000 + i))),
    );
    expect(() =>
      evaluateVA1Forward(clusters, { maxDegenerateFraction: 1.5 }, mulberry32(1)),
    ).toThrow(/maxDegenerateFraction/);
  });

  it('OCR finding 6: valid override still runs (does not over-reject)', () => {
    eidCounter = 0;
    const clusters = assembleForwardClusters(
      flatten(Array.from({ length: 12 }, (_, i) => signalCluster(`c${i}`, 8, 16000 + i))),
    );
    // sane overrides must NOT throw.
    expect(() =>
      evaluateVA1Forward(clusters, { bootstrapB: 500, deltaThreshold: 0.05 }, mulberry32(1)),
    ).not.toThrow();
  });
});

describe('formatReport', () => {
  it('contains verdict, ΔAUC, nWithRt, effectiveN and a caveat line', () => {
    const result: VA1Result = {
      verdict: 'INSUFFICIENT',
      pointDelta: 0.0123,
      aucSrt: 0.61,
      aucBinary: 0.6,
      ci: { lo: -0.01, hi: 0.05 },
      b: 1800,
      degenerateFraction: 0.0,
      nTotal: 50,
      nWithRt: 40,
      n1: 22,
      n0: 18,
      kClusters: 5,
      deff: 1.4,
      effectiveN: 28.5,
      familyDeltaAppliedCount: 3,
      familyDeltaTotal: 40,
      partialDropped: 2,
      reason: 'effectiveN 28.5 < floor 100',
      config: { ...TEST_CONFIG },
    };
    const text = formatReport(result);
    expect(text).toMatch(/INSUFFICIENT/);
    expect(text).toMatch(/AUC/);
    expect(text).toMatch(/0\.0123|ΔAUC|pointDelta/i);
    expect(text).toMatch(/nWithRt|RT-bearing/i);
    expect(text).toMatch(/effectiveN|effective N/i);
    // caveat: floor is a coarse heuristic, the CI is the decision
    expect(text.toLowerCase()).toMatch(/heuristic|coarse|ci is the (decision|inference)/);
  });

  it('prints the actual config thresholds used for the evaluation', () => {
    const result: VA1Result = {
      verdict: 'PASS',
      pointDelta: 0.1,
      aucSrt: 0.7,
      aucBinary: 0.6,
      ci: { lo: 0.05, hi: 0.15 },
      b: 500,
      degenerateFraction: 0,
      nTotal: 200,
      nWithRt: 180,
      n1: 100,
      n0: 80,
      kClusters: 18,
      deff: 1.2,
      effectiveN: 150,
      familyDeltaAppliedCount: 0,
      familyDeltaTotal: 180,
      partialDropped: 0,
      reason: 'PASS',
      config: {
        effectiveNFloor: 75,
        minKcClusters: 8,
        deltaThreshold: 0.05,
        bootstrapB: 500,
        maxDegenerateFraction: 0.1,
        multiKcScoring: false,
      },
    };
    const text = formatReport(result);
    expect(text).toMatch(/effectiveN floor \(75\)/);
    expect(text).toMatch(/minKcClusters \(8\)/);
    expect(text).toMatch(/ΔAUC threshold 0\.05/);
  });

  it('json mode returns parseable JSON', () => {
    const result: VA1Result = {
      verdict: 'PASS',
      pointDelta: 0.1,
      aucSrt: 0.7,
      aucBinary: 0.6,
      ci: { lo: 0.05, hi: 0.15 },
      b: 2000,
      degenerateFraction: 0,
      nTotal: 200,
      nWithRt: 180,
      n1: 100,
      n0: 80,
      kClusters: 18,
      deff: 1.2,
      effectiveN: 150,
      familyDeltaAppliedCount: 0,
      familyDeltaTotal: 180,
      partialDropped: 0,
      reason: 'PASS',
      config: { ...TEST_CONFIG },
    };
    const text = formatReport(result, { json: true });
    const parsed = JSON.parse(text);
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.pointDelta).toBe(0.1);
  });
});

// ── YUK-466: θ_global fidelity — the assembler replays the FULL ordered list (every KC of a
// domain interleaved), so a scored KC's forward θ̂ folds in θ_global drift contributed by
// SIBLING-KC attempts in the same domain. A per-KC partition (the old bug) would replay only
// the scored KC's own attempts, missing that shared-domain drift. ──
describe('assembleForwardClusters — θ_global cross-KC fidelity (YUK-466)', () => {
  it('forward prediction folds in θ_global drift from same-domain sibling-KC attempts', () => {
    expect(HIERARCHICAL_ELO_ENABLED).toBe(true); // guard: θ_global only drifts when live flag on

    const DOMAIN = 'dShared';
    const list: ReplayAttempt[] = [];
    let t = 0;

    // 6 MULTI-KC sibling attempts in the SAME domain: NOT forward-scorable (scoredKnowledgeId
    // null), but each drifts θ_global(dShared) up (replay.ts:207-227). 'a' touches none of them.
    for (let i = 0; i < 6; i++) {
      list.push({
        knowledgeIds: ['sibA', 'sibB'],
        scoredKnowledgeId: null,
        domainByKc: { sibA: DOMAIN, sibB: DOMAIN },
        outcome: 1,
        difficulty: 3,
        b: 0,
        bWeight: 1,
        responseTimeMs: 8000,
        createdAt: ++t,
        eventId: `sib${i}`,
      });
    }
    // Then scored single-KC 'a' attempts in the SAME domain, RT-bearing, both classes.
    for (let i = 0; i < 4; i++) {
      list.push({
        knowledgeIds: ['a'],
        scoredKnowledgeId: 'a',
        domainByKc: { a: DOMAIN },
        outcome: (i % 2) as 0 | 1,
        difficulty: 3,
        b: 0,
        bWeight: 1,
        responseTimeMs: 8000,
        createdAt: ++t,
        eventId: `a${i}`,
      });
    }

    // Only 'a' is forward-scorable → exactly one cluster.
    const { clusters } = assembleForwardClustersDetailed(list);
    expect(clusters).toHaveLength(1);
    const aCluster = clusters[0];

    // Ground truth: replay the FULL list vs replay ONLY 'a''s attempts (the old per-KC view).
    const aStepFull = replayTheta(list, { srtEnabled: false }).steps.find(
      (s) => s.scoredKnowledgeId === 'a',
    );
    const aOnly = list.filter((x) => x.scoredKnowledgeId === 'a');
    const aStepOnly = replayTheta(aOnly, { srtEnabled: false }).steps.find(
      (s) => s.scoredKnowledgeId === 'a',
    );
    expect(aStepFull).toBeDefined();
    expect(aStepOnly).toBeDefined();

    // The sibling attempts drifted θ_global(dShared) UP before 'a''s first attempt, so the
    // full-timeline pre-attempt θ̂ strictly exceeds the per-KC-only one (which sees no drift).
    expect(aStepFull?.preAttemptEffectiveTheta ?? 0).toBeGreaterThan(
      aStepOnly?.preAttemptEffectiveTheta ?? 0,
    );

    // The assembler's first scored prediction MUST equal the full-timeline value (YUK-466),
    // and must NOT equal the per-KC-only value the old partition would have produced.
    expect(aCluster.scoresBinary[0]).toBeCloseTo(aStepFull?.predictedP ?? Number.NaN, 12);
    expect(aCluster.scoresBinary[0]).not.toBeCloseTo(aStepOnly?.predictedP ?? Number.NaN, 6);
  });
});

// ── YUK-463: multi-KC forward scoring — multi-KC attempts (replayed for trajectory fidelity
// but excluded from the Wave-0 scored pool) are folded in via the conjunctive item prediction,
// bucketed into combo clusters DISJOINT from the single-KC clusters. ──
describe('assembleForwardClusters — YUK-463 multi-KC combo scoring', () => {
  // A RT-bearing multi-KC attempt over the given (possibly unsorted) KC set.
  function multiKc(kcs: string[], outcome: 0 | 1, createdAt: number): ReplayAttempt {
    return {
      knowledgeIds: kcs,
      scoredKnowledgeId: null,
      domainByKc: Object.fromEntries(kcs.map((k) => [k, null])),
      outcome,
      difficulty: 3,
      b: 0,
      bWeight: 1,
      responseTimeMs: 8000,
      createdAt,
      eventId: nextEid(),
    };
  }

  it('flag OFF (default) excludes multi-KC attempts — byte-identical to the single-KC-only pool', () => {
    eidCounter = 0;
    const list: ReplayAttempt[] = [
      singleKcAttempt('a', 1, 5000, 1),
      multiKc(['a', 'b'], 1, 2),
      singleKcAttempt('a', 0, 45000, 3),
      multiKc(['a', 'b'], 0, 4),
    ];
    const off = assembleForwardClustersDetailed(list);
    const offExplicit = assembleForwardClustersDetailed(list, { multiKcScoring: false });
    // default arg === explicit-false (byte-identical).
    expect(off).toEqual(offExplicit);
    // exactly ONE single-KC cluster ('a' with its 2 single-KC attempts), NO combo clusters.
    expect(off.clusters).toHaveLength(1);
    expect(off.clusters[0].labels).toHaveLength(2);
    // nTotalScorable counts only the 2 single-KC scorable steps (multi-KC excluded when off).
    expect(off.nTotalScorable).toBe(2);
  });

  it('flag ON buckets RT-bearing multi-KC attempts into a combo cluster keyed by the SORTED KC set', () => {
    eidCounter = 0;
    const list: ReplayAttempt[] = [
      multiKc(['b', 'a'], 1, 1),
      multiKc(['a', 'b'], 0, 2), // same sorted set 'a|b' → SAME combo cluster
      multiKc(['c', 'a'], 1, 3), // sorted 'a|c' → DIFFERENT combo cluster
    ];
    const { clusters } = assembleForwardClustersDetailed(list, { multiKcScoring: true });
    // two combo clusters: {a|b: 2 labels}, {a|c: 1 label}. No single-KC clusters.
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.labels.length).sort()).toEqual([1, 2]);
  });

  it('cluster INDEPENDENCE: a multi-KC [a,b] attempt never pollutes the single-KC "a" cluster', () => {
    eidCounter = 0;
    const list: ReplayAttempt[] = [
      singleKcAttempt('a', 1, 5000, 1),
      singleKcAttempt('a', 0, 45000, 2),
      singleKcAttempt('a', 1, 6000, 3),
      multiKc(['a', 'b'], 1, 4),
      multiKc(['a', 'b'], 0, 5),
    ];
    const { clusters } = assembleForwardClustersDetailed(list, { multiKcScoring: true });
    // single-KC 'a' cluster (3 attempts) + combo 'a|b' cluster (2 attempts) = 2 DISJOINT clusters.
    expect(clusters).toHaveLength(2);
    // total labels = 5 = 3 single + 2 combo; NO double-counting.
    expect(clusters.reduce((acc, c) => acc + c.labels.length, 0)).toBe(5);
    expect(clusters.map((c) => c.labels.length).sort()).toEqual([2, 3]);
  });

  it('flag ON: RT-less multi-KC attempts are excluded from clusters but counted in nTotalScorable (mirror of single-KC M4)', () => {
    eidCounter = 0;
    const list: ReplayAttempt[] = [
      multiKc(['a', 'b'], 1, 1),
      { ...multiKc(['a', 'b'], 0, 2), responseTimeMs: null }, // RT-less → excluded from clusters
    ];
    const { clusters, nTotalScorable } = assembleForwardClustersDetailed(list, {
      multiKcScoring: true,
    });
    // one combo cluster with only the RT-bearing attempt (1 label).
    expect(clusters).toHaveLength(1);
    expect(clusters[0].labels).toHaveLength(1);
    // nTotalScorable counts BOTH multi-KC scorable steps (incl. the RT-less one) = 2.
    expect(nTotalScorable).toBe(2);
  });

  it('flag ON: a multi-KC pool flows through evaluateVA1Forward with sane n1/n0/kClusters', () => {
    eidCounter = 0;
    // 12 distinct sorted KC pairs × 12 RT-bearing attempts each, mixed outcomes → ample combo pool.
    const list: ReplayAttempt[] = [];
    let t = 0;
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        list.push(multiKc([`x${i}`, `y${i}`], (j % 2) as 0 | 1, ++t));
      }
    }
    const { clusters } = assembleForwardClustersDetailed(list, { multiKcScoring: true });
    expect(clusters).toHaveLength(12); // 12 distinct sorted KC pairs
    const r = evaluateVA1Forward(clusters, { multiKcScoring: true }, mulberry32(99));
    // both classes present + 12 clusters → past the n1/n0 class floor; kClusters reported.
    expect(r.n1).toBeGreaterThan(0);
    expect(r.n0).toBeGreaterThan(0);
    expect(r.kClusters).toBe(12);
    expect(['PASS', 'FAIL', 'INSUFFICIENT']).toContain(r.verdict);
    // the report surfaces the multi-KC-on caveat.
    const onReport = formatReport(r);
    expect(onReport).toMatch(/MULTI-KC SCORING ON/);
    // YUK-463 honest-N: flag-ON report must NOT carry the single-KC-only labels/caveat that
    // would misreport the (now combo-inclusive) N/clusters. The evidence-base + caveat lines
    // are conditioned on multiKcScoring so the report stays internally consistent.
    expect(onReport).toMatch(/single-KC \+ multi-KC combo forward-scorable/);
    expect(onReport).toMatch(/KC \+ combo clusters with RT-bearing forward preds/);
    expect(onReport).not.toMatch(/N keys on RT-BEARING single-KC attempts only/);
  });
});
