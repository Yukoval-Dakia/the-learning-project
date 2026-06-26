// YUK-495 Phase 1 (S5) — WASM EXECUTION-parity: the SAME Rust crate compiled to
// `wasm32-wasip1-threads` (the browser / #41-recompute-badge target) vs the JS ORACLE
// (the live src/server/calibration/* + src/core/poly-exp.ts), asserted Object.is-equal.
//
// This closes the U1 unknown that Phase 0 deferred (spike §U1 "execution-parity =
// Phase-1 plumbing"): it empirically proves the isomorphic-core chain end-to-end —
//   server napi (.node)  ≡  browser WASM (.wasm)  ≡  JS oracle  — bit-for-bit.
// native-parity.unit.test.ts proves the .node leg; this proves the .wasm leg against
// the same oracle, so the two binaries agree transitively.
//
// Determinism contract (identical to crates/calibration-native/src/lib.rs + poly-exp.ts):
//   - every op the core uses (+ − × ÷ compare sort floor) is IEEE-754 correctly-rounded
//     → identical on wasm32 / V8 / native; the one non-IEEE op (exp) is rebuilt from
//     + − × ÷ by the shared polynomial (no FMA), so it is bit-exact across all three.
//
// Skip-if-absent (mirrors native-parity): the .wasm is opt-in / dev-CI-only, built by
// `pnpm build:native:wasm`. When absent this suite SKIPS — the JS oracle is the
// production path, so a missing WASM toolchain never reds the gate. The crate-local
// loader deps (@napi-rs/wasm-runtime + @emnapi/*) are dev-only and never enter prod.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { polyExp, polySigmoid } from '@/core/poly-exp';
import { forwardAuc } from '@/server/calibration/auc';
import {
  type ClusterForwardPreds,
  deltaAucClusterBootstrap,
  resolveBootstrapB,
} from '@/server/calibration/bootstrap';
import { mulberry32 } from '@/server/calibration/rng';
import { describe, expect, it } from 'vitest';

// Load the WASI loader DIRECTLY (not the index.js dispatcher) so this suite always
// exercises the WASM binding — never a stray `.node` (index.js prefers native). The
// `.wasi.cjs` requires the crate-local @napi-rs/wasm-runtime + @emnapi/* (resolved
// upward from the crate dir) and a worker_threads-backed shared-memory WASI runtime.
const WASM_PATH = resolve('crates/calibration-native/calibration-native.wasm32-wasi.wasm');
const WASI_LOADER = resolve('crates/calibration-native/calibration-native.wasi.cjs');
const present = existsSync(WASM_PATH) && existsSync(WASI_LOADER);

interface Addon {
  mulberry32Draws(seed: number, n: number): number[];
  forwardAuc(
    scores: number[],
    labels: number[],
  ): { auc?: number | null; n: number; n1: number; n0: number; reason?: string | null };
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
  polyExpBatch(xs: number[]): number[];
  polySigmoidBatch(xs: number[]): number[];
}

function loadWasm(): Addon | null {
  if (!present) return null;
  try {
    return createRequire(import.meta.url)(WASI_LOADER) as Addon;
  } catch {
    // The .wasm/loader exist but fail to instantiate (no shared-memory / WASI support
    // in this Node, stale artifact). Treat as absent — JS oracle is the prod path, so
    // SKIP rather than red. (Same skip-if-absent contract as native-parity.)
    return null;
  }
}
const addon: Addon | null = loadWasm();

// napi maps Rust Option<f64> None -> JS `undefined`; the JS oracle returns `null`.
const nn = (x: number | null | undefined): number | null => (x == null ? null : x);

const d = present && addon ? describe : describe.skip;

d('calibration-native WASM ↔ JS oracle execution-parity (YUK-495 S5)', () => {
  const a = addon as Addon;

  // ── Layer 0 — mulberry32 (the PRNG stream both bootstrap legs depend on) ────
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

  // ── Layer 1 — forwardAuc (Mann–Whitney U; integer-exact accumulation) ───────
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
    // labels marshalled as Vec<f64> (not Vec<u32>) so N-API ToUint32 can't coerce a
    // fractional/negative non-binary label and diverge from the oracle's reject path.
    for (const bad of [1.5, -1, 2.5]) {
      expect(() => forwardAuc([1, 2], [0, bad] as unknown as (0 | 1)[])).toThrow(/must be 0 or 1/);
      expect(() => a.forwardAuc([1, 2], [0, bad])).toThrow(/must be 0 or 1/);
    }
  });

  // ── Layer 2 — resolveBootstrapB (perf-cap tiers) ───────────────────────────
  it('Layer 2 — resolveBootstrapB: tier grid exact', () => {
    const ns = [1000, 5000, 5001, 20000, 20001, 1_000_000];
    const bs = [2000, 500, 300, 200, 100];
    for (const n of ns) {
      for (const b of bs) {
        expect(a.resolveBootstrapB(n, b)).toBe(resolveBootstrapB(n, b));
      }
    }
  });

  // ── Layer 3 — deltaAucClusterBootstrap (full DeltaAucCi; the sort+percentile path) ──
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
    expect(rust.degenerateReplicates + rust.b).toBe(js.degenerateReplicates + js.b);
  };

  const runBoth = (clusters: ClusterForwardPreds[], b: number, seed: number) =>
    deltaEq(
      a.deltaAucClusterBootstrap(clusters, b, seed >>> 0),
      deltaAucClusterBootstrap(clusters, { b, rng: mulberry32(seed >>> 0) }),
    );

  const gen = mulberry32(0xc0ffee);
  const cluster = (n: number, srtGood: boolean): ClusterForwardPreds => {
    const scoresSrt: number[] = [];
    const scoresBinary: number[] = [];
    const labels: (0 | 1)[] = [];
    for (let i = 0; i < n; i++) {
      const y: 0 | 1 = gen() < 0.5 ? 1 : 0;
      labels.push(y);
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

  it('Layer 3 — misaligned cluster throws both sides', () => {
    const bad: ClusterForwardPreds[] = [{ scoresSrt: [1, 2], scoresBinary: [1], labels: [0, 1] }];
    expect(() => deltaAucClusterBootstrap(bad, { b: 10, rng: mulberry32(1) })).toThrow(
      /equal length/,
    );
    expect(() => a.deltaAucClusterBootstrap(bad, 10, 1)).toThrow(/equal length/);
  });

  // ── Layer 4 — poly exp/σ (decision ②; the non-IEEE op rebuilt bit-exact) ────
  // The σ swap target for #41's recompute badge — the WHOLE reason WASM execution-parity
  // is load-bearing (the browser badge re-derives p(L)/lo/hi via this exact σ).
  const buildPolyGrid = (): number[] => {
    const xs: number[] = [];
    for (let x = -25; x <= 25; x += 0.01) xs.push(Number(x.toFixed(2)));
    const LN2 = Math.log(2);
    for (let k = -60; k <= 60; k++) {
      xs.push(k * LN2);
      xs.push(k * LN2 + 1e-12);
      xs.push(k * LN2 - 1e-12);
      xs.push((k + 0.5) * LN2); // half-way floor-flip point
    }
    xs.push(0, -0, 1, -1, 0.5, -0.5, 1e-300, -1e-300, 708, -745, 709, -746);
    xs.push(-700, -707.9, -708, -708.5, -709, -710, -720, 707.9, 708.1);
    xs.push(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
    const PFA_GAMMA = 0.4;
    const PFA_RHO = -0.2;
    for (const beta of [-1.5, 0, 0.8, 2.3]) {
      for (const succ of [0, 1, 5, 12]) {
        for (const fail of [0, 1, 4]) {
          const logit = PFA_GAMMA * succ + PFA_RHO * fail - beta;
          for (const prec of [1, 2.5, 9, 50]) {
            const se = 1 / Math.sqrt(Math.max(prec, 1e-9));
            xs.push(logit, logit - se, logit + se);
          }
        }
      }
    }
    return xs;
  };

  it('Layer 4 — polyExp: WASM ≡ TS Object.is across the stress grid (incl. NaN/±Inf/tails)', () => {
    const grid = buildPolyGrid();
    const rust = a.polyExpBatch(grid);
    expect(rust.length).toBe(grid.length);
    for (let i = 0; i < grid.length; i++) {
      expect(Object.is(rust[i], polyExp(grid[i]))).toBe(true);
    }
  });

  it('Layer 4 — polySigmoid: WASM ≡ TS Object.is across the stress grid (the σ swap target)', () => {
    const grid = buildPolyGrid();
    const rust = a.polySigmoidBatch(grid);
    expect(rust.length).toBe(grid.length);
    for (let i = 0; i < grid.length; i++) {
      expect(Object.is(rust[i], polySigmoid(grid[i]))).toBe(true);
    }
  });

  it('Layer 4 — 1000 randomized σ-range draws (seeded) Object.is-equal', () => {
    let s = 0x9e3779b9 >>> 0;
    const rng = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const xs = Array.from({ length: 1000 }, () => rng() * 80 - 40);
    const re = a.polyExpBatch(xs);
    const rs = a.polySigmoidBatch(xs);
    for (let i = 0; i < xs.length; i++) {
      expect(Object.is(re[i], polyExp(xs[i]))).toBe(true);
      expect(Object.is(rs[i], polySigmoid(xs[i]))).toBe(true);
    }
  });
});
