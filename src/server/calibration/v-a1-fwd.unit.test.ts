// TASK 9 — V-A1-fwd keystone gate (PURE): assemble forward clusters from the replay
// engine, run the paired cluster bootstrap, emit a PASS/FAIL/INSUFFICIENT verdict +
// human report. Synthetic end-to-end tests are answer-BY-CONSTRUCTION (the generating
// model determines the verdict; RNG seeded for determinism).

import { describe, expect, it } from 'vitest';
import type { ReplayAttempt } from './replay';
import { mulberry32 } from './rng';
import {
  type VA1Result,
  assembleForwardClusters,
  evaluateVA1Forward,
  formatReport,
} from './v-a1-fwd';

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

function toMap(clusters: ReplayAttempt[][]): Map<string, ReplayAttempt[]> {
  const m = new Map<string, ReplayAttempt[]>();
  for (const c of clusters) {
    if (c.length > 0) m.set(c[0].knowledgeIds[0], c);
  }
  return m;
}

describe('evaluateVA1Forward — keystone gate', () => {
  it('PASS: ample RT-bearing single-KC data where SRT clearly helps', () => {
    eidCounter = 0;
    const clustersRaw = Array.from({ length: 18 }, (_, i) => signalCluster(`kc${i}`, 14, 5000 + i));
    const clusters = assembleForwardClusters(toMap(clustersRaw));
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
    const clusters = assembleForwardClusters(toMap(clustersRaw));
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
    const clusters = assembleForwardClusters(toMap(clustersRaw));
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
    const clusters = assembleForwardClusters(toMap(clustersRaw));
    const r = evaluateVA1Forward(clusters, {}, mulberry32(3));
    expect(r.nWithRt).toBe(0);
    expect(r.verdict).toBe('INSUFFICIENT'); // RT-less corpus cannot pass (M4)
  });

  it('FAIL: ample RT but RT independent of correctness (null signal)', () => {
    eidCounter = 0;
    const clustersRaw = Array.from({ length: 18 }, (_, i) => nullCluster(`f${i}`, 14, 7000 + i));
    const clusters = assembleForwardClusters(toMap(clustersRaw));
    const r = evaluateVA1Forward(clusters, {}, mulberry32(11));
    // Clears the floors (ample data) but no SRT advantage → not a PASS. Either FAIL
    // (CI straddles 0 / pointDelta <= threshold).
    expect(r.verdict).toBe('FAIL');
    expect(r.ci.lo).toBeLessThanOrEqual(0);
  });

  it('determinism: same seed → identical verdict + CI', () => {
    eidCounter = 0;
    const clustersRaw = Array.from({ length: 15 }, (_, i) => signalCluster(`d${i}`, 12, 9000 + i));
    const clusters = assembleForwardClusters(toMap(clustersRaw));
    const a = evaluateVA1Forward(clusters, {}, mulberry32(77));
    const b = evaluateVA1Forward(clusters, {}, mulberry32(77));
    expect(a.verdict).toBe(b.verdict);
    expect(a.ci.lo).toBe(b.ci.lo);
    expect(a.ci.hi).toBe(b.ci.hi);
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
    };
    const text = formatReport(result, { json: true });
    const parsed = JSON.parse(text);
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.pointDelta).toBe(0.1);
  });
});
