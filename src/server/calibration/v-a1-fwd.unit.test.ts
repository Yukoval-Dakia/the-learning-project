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
