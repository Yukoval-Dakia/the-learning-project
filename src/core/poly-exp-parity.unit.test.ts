// YUK-495 Phase 0 (decision ②) — JS↔Rust BIT-parity of the shared polynomial exp/σ.
//
// Asserts the Rust port (crates/calibration-native poly_exp_batch / poly_sigmoid_batch)
// is `Object.is`-equal to the TS oracle (src/core/poly-exp.ts) across a grid that
// stresses the range-reduction boundaries + the real θ̂/p(L) σ inputs. This is the
// proof behind decision ②: with the shared polynomial, σ itself is bit-for-bit across
// languages (no ULP carve-out), so #41's recompute badge is literally reproducible.
//
// Skip-if-absent (mirrors native-parity.unit.test.ts): the .node is opt-in / dev-CI-only
// (`pnpm build:native`); when absent this suite SKIPS — the TS poly is the always-on path.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { polyExp, polySigmoid } from './poly-exp';

const NODE_PATH = resolve('crates/calibration-native/calibration-native.node');
const present = existsSync(NODE_PATH);

interface PolyAddon {
  polyExpBatch(xs: number[]): number[];
  polySigmoidBatch(xs: number[]): number[];
}

function loadAddon(): PolyAddon | null {
  if (!present) return null;
  try {
    return createRequire(import.meta.url)(NODE_PATH) as PolyAddon;
  } catch {
    return null;
  }
}
const addon = loadAddon();
const d = present && addon ? describe : describe.skip;

// A grid that stresses the determinism-sensitive paths:
function buildGrid(): number[] {
  const xs: number[] = [];
  // σ operating range, fine step (covers the θ̂/p(L)/pLearnedBand domain).
  for (let x = -25; x <= 25; x += 0.01) xs.push(Number(x.toFixed(2)));
  // range-reduction boundaries: near k·ln2 and the half-way k flips (where floor(x·LOG2E+0.5)
  // changes) — the most likely place a tie/rounding divergence would surface.
  const LN2 = Math.log(2);
  for (let k = -60; k <= 60; k++) {
    xs.push(k * LN2);
    xs.push(k * LN2 + 1e-12);
    xs.push(k * LN2 - 1e-12);
    xs.push((k + 0.5) * LN2); // half-way flip point
  }
  // exact anchors + signed zero + sub-normal-ish + tails + non-finite.
  xs.push(0, -0, 1, -1, 0.5, -0.5, 1e-300, -1e-300, 708, -745, 709, -746);
  xs.push(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
  // realistic pLearnedBand inputs: pointLogit ± thetaSe for representative (β, succ, fail, se).
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
}

d('poly-exp ↔ Rust bit-parity (YUK-495 Phase 0, decision ②)', () => {
  const a = addon as PolyAddon;
  const grid = buildGrid();

  it('polyExp: Rust ≡ TS Object.is across the stress grid (incl. NaN/±Inf)', () => {
    const rust = a.polyExpBatch(grid);
    expect(rust.length).toBe(grid.length);
    for (let i = 0; i < grid.length; i++) {
      const js = polyExp(grid[i]);
      // Object.is treats NaN===NaN true and -0/+0 distinct — exactly the parity we want.
      expect(Object.is(rust[i], js)).toBe(true);
    }
  });

  it('polySigmoid: Rust ≡ TS Object.is across the stress grid (the σ swap target)', () => {
    const rust = a.polySigmoidBatch(grid);
    expect(rust.length).toBe(grid.length);
    for (let i = 0; i < grid.length; i++) {
      const js = polySigmoid(grid[i]);
      expect(Object.is(rust[i], js)).toBe(true);
    }
  });

  it('1000 randomized σ-range draws (seeded) Object.is-equal', () => {
    // local mulberry32 (mirror of rng.ts) for a reproducible adversarial sweep.
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
