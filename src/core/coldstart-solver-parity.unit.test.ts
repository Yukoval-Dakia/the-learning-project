// YUK-495 Phase 1 (#125 rider) — JS↔Rust BIT-parity of the one-KC cold-start solver.
// The grid fold's accumulation order + the shared poly σ make θ̂ and SE Object.is-equal
// between V8 and the Rust addon — retiring the largest NEW determinism risk (the #125
// sweep/fold contract) before the coupled multi-KC EM (Phase 3) is built on top.
// Skip-if-absent (mirrors native-parity.unit.test.ts): .node is opt-in/dev-CI-only.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { solveThetaOneKc } from './coldstart-solver';

const NODE_PATH = resolve('crates/calibration-native/calibration-native.node');
const present = existsSync(NODE_PATH);

interface SolverAddon {
  solveThetaOneKc(
    bPrime: number,
    answers: number[],
  ): { thetaHat: number; se: number; evidence: number };
}
function loadAddon(): SolverAddon | null {
  if (!present) return null;
  try {
    return createRequire(import.meta.url)(NODE_PATH) as SolverAddon;
  } catch {
    return null;
  }
}
const addon = loadAddon();
const d = present && addon ? describe : describe.skip;

d('coldstart-solver ↔ Rust bit-parity (YUK-495 #125 rider)', () => {
  const a = addon as SolverAddon;

  const eq = (bPrime: number, answers: (0 | 1)[]) => {
    const js = solveThetaOneKc(bPrime, answers);
    const rust = a.solveThetaOneKc(bPrime, answers as unknown as number[]);
    expect(Object.is(rust.thetaHat, js.thetaHat)).toBe(true);
    expect(Object.is(rust.se, js.se)).toBe(true);
    expect(rust.evidence).toBe(js.evidence);
  };

  it('curated cases: cold start, all-right, all-wrong, mixed, ragged anchors', () => {
    const anchors = [-3, -1.5, -0.5, 0, 0.7, 1.5, 3];
    const seqs: (0 | 1)[][] = [
      [],
      [1],
      [0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [1, 0, 1, 0, 1, 0],
      [1, 1, 1, 0, 1, 1, 0, 1],
      Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 1 : 0) as 0 | 1),
    ];
    for (const b of anchors) for (const s of seqs) eq(b, s);
  });

  it('1000 randomized (seeded) anchor × answer-sequence draws Object.is-equal', () => {
    let s = 0xc0ffee >>> 0;
    const rng = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let c = 0; c < 1000; c++) {
      const bPrime = rng() * 8 - 4;
      const len = Math.floor(rng() * 25);
      const answers = Array.from({ length: len }, () => (rng() < 0.5 ? 1 : 0) as 0 | 1);
      eq(bPrime, answers);
    }
  });
});
