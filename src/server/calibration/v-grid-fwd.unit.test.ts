// V-grid-fwd unit tests (YUK-436) — assembleGridForwardClusters bucketing + the advisory
// verdict logic (READY_FOR_FLIP / NOT_READY / INSUFFICIENT) on synthetic clusters. PURE.
//
// The grid track's faithfulness to production is proven separately by
// replay.fixture.db.test.ts; here we test the comparison harness wiring + thresholds.

import { expectedScore } from '@/core/theta';
import { describe, expect, it } from 'vitest';
import type { ClusterForwardPreds } from './bootstrap';
import type { ReplayAttempt } from './replay';
import { mulberry32 } from './rng';
import { type GridPooled, assembleGridForwardClusters, evaluateGridForward } from './v-grid-fwd';

const SEED = 0x9e37_79b9;

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

/**
 * Build clusters + aligned pooled predictions from per-observation (predGrid, predLive,
 * label) triples, round-robin'd into `k` clusters. Keeps clusters (AUC source) and pooled
 * (ECE source) perfectly consistent — exactly what assembleGridForwardClusters produces.
 */
function buildClusters(
  triples: Array<{ g: number; l: number; y: 0 | 1 }>,
  k: number,
): { clusters: ClusterForwardPreds[]; pooled: GridPooled } {
  const buckets: ClusterForwardPreds[] = Array.from({ length: k }, () => ({
    scoresSrt: [],
    scoresBinary: [],
    labels: [],
  }));
  const pooled: GridPooled = { predGrid: [], predLive: [], labels: [] };
  triples.forEach((t, i) => {
    const c = buckets[i % k];
    c.scoresSrt.push(t.g);
    c.scoresBinary.push(t.l);
    c.labels.push(t.y);
    pooled.predGrid.push(t.g);
    pooled.predLive.push(t.l);
    pooled.labels.push(t.y);
  });
  return { clusters: buckets, pooled };
}

/**
 * A well-powered set of balanced clusters built DIRECTLY (not via round-robin, which would
 * alias the inner label structure into single-class clusters). 12 clusters × 12 obs (6
 * correct, 6 wrong each) → N=144, every cluster mean 0.5 → ICC≈0 → deff≈1 → effectiveN≈144
 * (>=100); kClusters=12 (>=10).
 */
function poweredClusters(
  gridScore: (y: 0 | 1) => number,
  liveScore: (y: 0 | 1) => number,
): { clusters: ClusterForwardPreds[]; pooled: GridPooled } {
  const clusters: ClusterForwardPreds[] = [];
  const pooled: GridPooled = { predGrid: [], predLive: [], labels: [] };
  for (let c = 0; c < 12; c++) {
    const entry: ClusterForwardPreds = { scoresSrt: [], scoresBinary: [], labels: [] };
    for (let j = 0; j < 12; j++) {
      const y: 0 | 1 = j < 6 ? 1 : 0;
      entry.scoresSrt.push(gridScore(y));
      entry.scoresBinary.push(liveScore(y));
      entry.labels.push(y);
      pooled.predGrid.push(gridScore(y));
      pooled.predLive.push(liveScore(y));
      pooled.labels.push(y);
    }
    clusters.push(entry);
  }
  return { clusters, pooled };
}

describe('assembleGridForwardClusters — bucketing + grid/live channel wiring', () => {
  it('buckets single-KC scorable steps by KC, skips multi-KC, aligns pooled', () => {
    const attempts: ReplayAttempt[] = [
      attempt({ knowledgeIds: ['k1'], outcome: 1, b: 0.2, eventId: 'a', createdAt: 1 }),
      attempt({ knowledgeIds: ['k1'], outcome: 0, b: 0.2, eventId: 'b', createdAt: 2 }),
      // multi-KC → skipped (no grid forward step).
      attempt({
        knowledgeIds: ['k1', 'k2'],
        scoredKnowledgeId: null,
        outcome: 1,
        b: 0.2,
        eventId: 'c',
        createdAt: 3,
      }),
      attempt({ knowledgeIds: ['k2'], outcome: 1, b: -0.3, eventId: 'd', createdAt: 4 }),
      attempt({ knowledgeIds: ['k2'], outcome: 0, b: -0.3, eventId: 'e', createdAt: 5 }),
    ];
    const { clusters, pooled, nScorable } = assembleGridForwardClusters(attempts);

    // two KCs → two clusters, in first-scored-appearance order [k1, k2].
    expect(clusters).toHaveLength(2);
    expect(clusters[0].labels).toEqual([1, 0]); // k1
    expect(clusters[1].labels).toEqual([1, 0]); // k2
    expect(nScorable).toBe(4); // 2 (k1) + 2 (k2); the multi-KC step excluded
    expect(pooled.predGrid).toHaveLength(4);
    expect(pooled.predLive).toHaveLength(4);
    expect(pooled.labels).toEqual([1, 0, 1, 0]);
  });

  it('grid vs live channels diverge: scoresSrt is the grid forward pred, scoresBinary the Elo+SRT pred', () => {
    const b = 0.2;
    const attempts: ReplayAttempt[] = [
      attempt({ knowledgeIds: ['k1'], outcome: 1, b, eventId: 'a', createdAt: 1 }),
      attempt({ knowledgeIds: ['k1'], outcome: 1, b, eventId: 'b', createdAt: 2 }),
    ];
    const { clusters } = assembleGridForwardClusters(attempts);
    const c = clusters[0];
    // 1st attempt cold start: grid posteriorMean 0 AND Elo θ 0 → both = expectedScore(0,b).
    expect(c.scoresSrt[0]).toBeCloseTo(expectedScore(0, b), 12);
    expect(c.scoresBinary[0]).toBeCloseTo(expectedScore(0, b), 12);
    // 2nd attempt: Elo θ̂ has moved by eloK*credit; grid posterior mean has moved by the
    // Bayes fold — different magnitudes → the two channels MUST differ (proves distinct wiring).
    expect(c.scoresSrt[1]).not.toBeCloseTo(c.scoresBinary[1], 6);
  });
});

describe('evaluateGridForward — advisory verdict logic', () => {
  it('READY_FOR_FLIP: grid == live (AUC parity, equal ECE) on well-powered data', () => {
    // identical grid/live scores correlated with the label → AUC well-defined, ΔAUC=0,
    // ECE_grid == ECE_live → non-inferior on both axes.
    const score = (y: 0 | 1) => (y === 1 ? 0.8 : 0.2);
    const { clusters, pooled } = poweredClusters(score, score);
    const r = evaluateGridForward(clusters, pooled, {}, mulberry32(SEED));
    expect(r.verdict).toBe('READY_FOR_FLIP');
    expect(r.pointDelta).toBeCloseTo(0, 12);
    expect(r.ci.lo).toBeGreaterThan(-0.02);
    expect(r.eceGrid).toBeCloseTo(r.eceLive, 12);
  });

  it('NOT_READY: grid AUC materially worse than live (CI lower bound below −deltaThreshold)', () => {
    // live ranks correctly; grid ranks BACKWARDS → AUC_grid≈0, AUC_live≈1 → ΔAUC≈−1.
    const live = (y: 0 | 1) => (y === 1 ? 0.8 : 0.2);
    const grid = (y: 0 | 1) => (y === 1 ? 0.2 : 0.8);
    const { clusters, pooled } = poweredClusters(grid, live);
    const r = evaluateGridForward(clusters, pooled, {}, mulberry32(SEED));
    expect(r.verdict).toBe('NOT_READY');
    expect(r.ci.lo).toBeLessThan(-0.02);
  });

  it('INSUFFICIENT: only one class present', () => {
    const triples = Array.from({ length: 144 }, () => ({ g: 0.6, l: 0.6, y: 1 as const }));
    const { clusters, pooled } = buildClusters(triples, 12);
    const r = evaluateGridForward(clusters, pooled, {}, mulberry32(SEED));
    expect(r.verdict).toBe('INSUFFICIENT');
    expect(r.n0).toBe(0);
  });

  it('INSUFFICIENT: underpowered (too few clusters / low effectiveN)', () => {
    // 3 clusters × 2 obs → kClusters 3 < 10, effectiveN ~6 < 100.
    const score = (y: 0 | 1) => (y === 1 ? 0.8 : 0.2);
    const triples: Array<{ g: number; l: number; y: 0 | 1 }> = [];
    for (let c = 0; c < 3; c++) {
      triples.push({ g: score(1), l: score(1), y: 1 });
      triples.push({ g: score(0), l: score(0), y: 0 });
    }
    const { clusters, pooled } = buildClusters(triples, 3);
    const r = evaluateGridForward(clusters, pooled, {}, mulberry32(SEED));
    expect(r.verdict).toBe('INSUFFICIENT');
    expect(r.kClusters).toBe(3);
    // point delta still reported for information.
    expect(Number.isNaN(r.pointDelta)).toBe(false);
  });

  it('AUC non-inferiority boundary: ciLo=0 is NOT > −deltaThreshold when deltaThreshold=0 → NOT_READY', () => {
    // grid == live → ΔAUC=0 → ciLo=0. With deltaThreshold 0, the strict 0 > −0 fails.
    const score = (y: 0 | 1) => (y === 1 ? 0.8 : 0.2);
    const { clusters, pooled } = poweredClusters(score, score);
    const r = evaluateGridForward(clusters, pooled, { deltaThreshold: 0 }, mulberry32(SEED));
    expect(r.ci.lo).toBeCloseTo(0, 12);
    expect(r.verdict).toBe('NOT_READY');
  });

  it('ECE-tolerance boundary: equal AUC but slightly worse grid calibration → NOT_READY @ eceTolerance=0, READY @ default', () => {
    // Two latent groups with intermediate accuracy so the predictor's CONFIDENCE can be
    // mis-stated relative to ACCURACY (true miscalibration, unlike a deterministic split):
    //   group A: accuracy 0.6 — live predicts 0.6 (calibrated), grid 0.61 (slightly over).
    //   group B: accuracy 0.4 — live predicts 0.4 (calibrated), grid 0.39 (slightly under).
    // Same ranking (A>B for both channels) → AUC parity (ΔAUC=0, ciLo=0 > −0.02). ECE_live=0,
    // ECE_grid≈0.01 — a gap inside the default 0.02 tolerance but outside a 0 tolerance.
    // 12 clusters × 10 obs (5 group-A, 5 group-B); cluster mean label 0.5 → ICC≈0 → effectiveN≈120.
    const clusters: ClusterForwardPreds[] = [];
    const pooled: GridPooled = { predGrid: [], predLive: [], labels: [] };
    for (let c = 0; c < 12; c++) {
      const entry: ClusterForwardPreds = { scoresSrt: [], scoresBinary: [], labels: [] };
      // group A (acc 0.6): 3 correct, 2 wrong; grid 0.61, live 0.6.
      // group B (acc 0.4): 2 correct, 3 wrong; grid 0.39, live 0.4.
      const groupA: (0 | 1)[] = [1, 1, 1, 0, 0];
      const groupB: (0 | 1)[] = [1, 1, 0, 0, 0];
      for (const y of groupA) {
        entry.scoresSrt.push(0.61);
        entry.scoresBinary.push(0.6);
        entry.labels.push(y);
        pooled.predGrid.push(0.61);
        pooled.predLive.push(0.6);
        pooled.labels.push(y);
      }
      for (const y of groupB) {
        entry.scoresSrt.push(0.39);
        entry.scoresBinary.push(0.4);
        entry.labels.push(y);
        pooled.predGrid.push(0.39);
        pooled.predLive.push(0.4);
        pooled.labels.push(y);
      }
      clusters.push(entry);
    }
    const r = evaluateGridForward(clusters, pooled, { eceTolerance: 0 }, mulberry32(SEED));
    expect(r.ci.lo).toBeGreaterThan(-0.02); // AUC non-inferior (same ranking)
    expect(r.eceGrid).toBeGreaterThan(r.eceLive); // grid slightly less calibrated
    expect(r.eceGrid - r.eceLive).toBeLessThan(0.02); // …but inside the default tolerance
    expect(r.verdict).toBe('NOT_READY');
    // default 0.02 tolerance absorbs the small ECE gap → READY.
    const r2 = evaluateGridForward(clusters, pooled, {}, mulberry32(SEED));
    expect(r2.verdict).toBe('READY_FOR_FLIP');
  });

  it('rejects an out-of-range config override (fails loud, no fabricated verdict)', () => {
    const score = (y: 0 | 1) => (y === 1 ? 0.8 : 0.2);
    const { clusters, pooled } = poweredClusters(score, score);
    expect(() =>
      evaluateGridForward(clusters, pooled, { bootstrapB: 0 }, mulberry32(SEED)),
    ).toThrow(/bootstrapB/);
  });
});
