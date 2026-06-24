// YUK-493 Phase -1 — differential parity: the napi crate (crates/calibration-native)
// vs the JS ORACLE (the live src/server/calibration/* used in production).
//
// The .node is OPT-IN / dev-CI-only: built by `pnpm build:native`. When absent
// (e.g. CI without Rust), this suite SKIPS rather than failing — the JS oracle is
// always the production path. When present, it asserts bit-exact parity.
//
// Determinism contract (see crates/calibration-native/src/lib.rs):
//   - seed-not-closure: JS uses mulberry32(seed); Rust takes seed; same stream.
//   - integer-exact AUC + no-FMA percentile → bit-exact f64, asserted via Object.is.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { forwardAuc } from '@/server/calibration/auc';
import {
  type ClusterForwardPreds,
  deltaAucClusterBootstrap,
  resolveBootstrapB,
} from '@/server/calibration/bootstrap';
import { mulberry32 } from '@/server/calibration/rng';
import { describe, expect, it } from 'vitest';

const NODE_PATH = resolve('crates/calibration-native/calibration-native.node');
const present = existsSync(NODE_PATH);

interface Addon {
  mulberry32Draws(seed: number, n: number): number[];
  forwardAuc(
    scores: number[],
    labels: number[],
  ): {
    auc?: number | null;
    n: number;
    n1: number;
    n0: number;
    reason?: string | null;
  };
  resolveBootstrapB(pooledN: number, requestedB: number): number;
  deltaAucClusterBootstrap(
    clusters: ClusterForwardPreds[],
    b: number,
    seed: number,
  ): {
    pointDelta: number;
    aucSrt?: number | null;
    aucBinary?: number | null;
    ciLo: number;
    ciHi: number;
    b: number;
    degenerateReplicates: number;
    degenerateFraction: number;
    excludesZero: boolean;
  };
}

const addon: Addon | null = present ? (createRequire(import.meta.url)(NODE_PATH) as Addon) : null;

// napi maps Rust Option<f64> None -> JS `undefined`; the JS oracle returns `null`.
const nn = (x: number | null | undefined): number | null => (x == null ? null : x);

const d = present && addon ? describe : describe.skip;

d('calibration-native ↔ JS oracle bit-parity (YUK-493 Phase -1)', () => {
  const a = addon as Addon;

  // ── Layer 0 — mulberry32 ──────────────────────────────────────────────────
  it('Layer 0 — mulberry32: 8 seeds × 1000 draws Object.is-equal; all in [0,1)', () => {
    const seeds = [1, 2, 99, 12345, 0x5eeda1c0, 0, 0xffffffff, 0x80000000];
    const N = 1000;
    for (const seed of seeds) {
      const s = seed >>> 0;
      const rng = mulberry32(s);
      const js = Array.from({ length: N }, () => rng());
      const rust = a.mulberry32Draws(s, N);
      expect(rust.length).toBe(N);
      for (let i = 0; i < N; i++) {
        expect(Object.is(rust[i], js[i])).toBe(true);
        expect(rust[i] >= 0 && rust[i] < 1).toBe(true);
      }
    }
  });

  // ── Layer 1 — forwardAuc ──────────────────────────────────────────────────
  const aucEq = (rust: ReturnType<Addon['forwardAuc']>, js: ReturnType<typeof forwardAuc>) => {
    const ra = nn(rust.auc);
    const ja = nn(js.auc);
    if (ra === null || ja === null) expect(ra).toBe(ja);
    else expect(Object.is(ra, ja)).toBe(true);
    expect(rust.n).toBe(js.n);
    expect(rust.n1).toBe(js.n1);
    expect(rust.n0).toBe(js.n0);
    expect(rust.reason ?? null).toBe(js.reason ?? null);
  };

  it('Layer 1 — forwardAuc: KAT + edge cases', () => {
    const kats: Array<[string, number[], (0 | 1)[]]> = [
      ['perfect', [1, 2, 3, 4], [0, 0, 1, 1]],
      ['inverted', [4, 3, 2, 1], [0, 0, 1, 1]],
      ['ties-half', [1, 1, 2, 2], [0, 1, 0, 1]],
      ['all-equal', [5, 5, 5, 5], [0, 1, 0, 1]],
      ['no-positives', [1, 2, 3], [0, 0, 0]],
      ['no-negatives', [1, 2, 3], [1, 1, 1]],
      ['empty', [], []],
      ['single-pos', [1], [1]],
      ['single-neg', [1], [0]],
      ['extreme', [1e308, -1e308, Number.MIN_VALUE, -0, 0], [1, 0, 1, 0, 1]],
      ['neg-vs-pos-zero', [-0, 0], [0, 1]],
    ];
    for (const [, scores, labels] of kats) {
      aucEq(a.forwardAuc(scores, labels), forwardAuc(scores, labels));
    }
  });

  it('Layer 1 — forwardAuc: 1000 randomized corpora (incl. tie-heavy) Object.is-equal', () => {
    const rng = mulberry32(0x1234abcd);
    for (let c = 0; c < 1000; c++) {
      const len = 1 + Math.floor(rng() * 30);
      const tieMode = rng() < 0.3;
      const scores: number[] = [];
      const labels: (0 | 1)[] = [];
      for (let i = 0; i < len; i++) {
        scores.push(tieMode ? Math.floor(rng() * 3) : rng() * 200 - 100);
        labels.push(rng() < 0.5 ? 1 : 0);
      }
      aucEq(a.forwardAuc(scores, labels), forwardAuc(scores, labels));
    }
  });

  it('Layer 1 — forwardAuc: error paths throw identical messages', () => {
    expect(() => forwardAuc([1, 2], [0] as (0 | 1)[])).toThrow(/equal length/);
    expect(() => a.forwardAuc([1, 2], [0])).toThrow(/equal length/);
    expect(() => forwardAuc([1, 2], [0, 2] as unknown as (0 | 1)[])).toThrow(/must be 0 or 1/);
    expect(() => a.forwardAuc([1, 2], [0, 2])).toThrow(/must be 0 or 1/);
  });

  // ── Layer 2 — resolveBootstrapB (the perf-cap tiers, cheap) ────────────────
  it('Layer 2 — resolveBootstrapB: tier grid exact', () => {
    const ns = [1000, 5000, 5001, 20000, 20001, 1_000_000];
    const bs = [2000, 500, 300, 200, 100];
    for (const n of ns) {
      for (const b of bs) {
        expect(a.resolveBootstrapB(n, b)).toBe(resolveBootstrapB(n, b));
      }
    }
  });

  // ── Layer 3 — deltaAucClusterBootstrap (full DeltaAucCi parity) ────────────
  const deltaEq = (
    rust: ReturnType<Addon['deltaAucClusterBootstrap']>,
    js: ReturnType<typeof deltaAucClusterBootstrap>,
  ) => {
    expect(Object.is(rust.pointDelta, js.pointDelta)).toBe(true);
    expect(nn(rust.aucSrt)).toBe(nn(js.aucSrt));
    expect(nn(rust.aucBinary)).toBe(nn(js.aucBinary));
    expect(Object.is(rust.ciLo, js.ciLo)).toBe(true);
    expect(Object.is(rust.ciHi, js.ciHi)).toBe(true);
    expect(rust.b).toBe(js.b);
    expect(rust.degenerateReplicates).toBe(js.degenerateReplicates);
    expect(Object.is(rust.degenerateFraction, js.degenerateFraction)).toBe(true);
    expect(rust.excludesZero).toBe(js.excludesZero);
    // structural invariant both sides
    expect(rust.degenerateReplicates + rust.b).toBe(js.degenerateReplicates + js.b);
  };

  const runBoth = (clusters: ClusterForwardPreds[], b: number, seed: number) =>
    deltaEq(
      a.deltaAucClusterBootstrap(clusters, b, seed >>> 0),
      deltaAucClusterBootstrap(clusters, { b, rng: mulberry32(seed >>> 0) }),
    );

  // Reproducible synthetic cluster corpora.
  const gen = mulberry32(0xc0ffee);
  const cluster = (n: number, srtGood: boolean): ClusterForwardPreds => {
    const scoresSrt: number[] = [];
    const scoresBinary: number[] = [];
    const labels: (0 | 1)[] = [];
    for (let i = 0; i < n; i++) {
      const y: 0 | 1 = gen() < 0.5 ? 1 : 0;
      labels.push(y);
      // SRT: separable when srtGood; binary: noisier
      scoresSrt.push(srtGood ? y + gen() * 0.4 : gen());
      scoresBinary.push(gen());
    }
    return { scoresSrt, scoresBinary, labels };
  };

  it('Layer 3 — strong-signal corpus across seeds × b', () => {
    const clusters = Array.from({ length: 20 }, () => cluster(8, true));
    for (const seed of [1, 7, 42, 99, 0x5eeda1c0]) {
      for (const b of [200, 500, 2000]) runBoth(clusters, b, seed);
    }
  });

  it('Layer 3 — null-signal (srt === binary) → Δ≈0', () => {
    const clusters = Array.from({ length: 12 }, () => {
      const c = cluster(6, false);
      return { ...c, scoresSrt: [...c.scoresBinary] };
    });
    for (const seed of [3, 11, 0x5eeda1c0]) runBoth(clusters, 500, seed);
  });

  it('Layer 3 — degenerate-heavy (tiny single-row clusters)', () => {
    const clusters = Array.from({ length: 6 }, (_, i) => ({
      scoresSrt: [gen()],
      scoresBinary: [gen()],
      labels: [(i % 2) as 0 | 1],
    }));
    for (const seed of [5, 17, 0x5eeda1c0]) runBoth(clusters, 300, seed);
  });

  it('Layer 3 — all-one-class pool → pointDelta NaN both sides', () => {
    const clusters = Array.from({ length: 4 }, () => ({
      scoresSrt: [gen(), gen(), gen()],
      scoresBinary: [gen(), gen(), gen()],
      labels: [1, 1, 1] as (0 | 1)[],
    }));
    runBoth(clusters, 200, 0x5eeda1c0);
  });

  it('Layer 3 — varied K × ragged sizes × class balance', () => {
    for (const k of [1, 2, 3, 5, 15]) {
      const clusters = Array.from({ length: k }, () =>
        cluster(1 + Math.floor(gen() * 10), gen() < 0.6),
      );
      for (const seed of [13, 0x5eeda1c0]) runBoth(clusters, 300, seed);
    }
  });

  it('Layer 3 — tie-saturated corpora (heavy == path)', () => {
    const clusters = Array.from({ length: 10 }, () => {
      const n = 6;
      const labels: (0 | 1)[] = [];
      const scoresSrt: number[] = [];
      const scoresBinary: number[] = [];
      for (let i = 0; i < n; i++) {
        labels.push(gen() < 0.5 ? 1 : 0);
        scoresSrt.push(Math.floor(gen() * 2)); // {0,1} → many ties
        scoresBinary.push(Math.floor(gen() * 2));
      }
      return { scoresSrt, scoresBinary, labels };
    });
    for (const seed of [23, 0x5eeda1c0]) runBoth(clusters, 500, seed);
  });

  it('Layer 3 — misaligned cluster throws both sides', () => {
    const bad: ClusterForwardPreds[] = [{ scoresSrt: [1, 2], scoresBinary: [1], labels: [0, 1] }];
    expect(() => deltaAucClusterBootstrap(bad, { b: 10, rng: mulberry32(1) })).toThrow(
      /equal length/,
    );
    expect(() => a.deltaAucClusterBootstrap(bad, 10, 1)).toThrow(/equal length/);
  });
});
