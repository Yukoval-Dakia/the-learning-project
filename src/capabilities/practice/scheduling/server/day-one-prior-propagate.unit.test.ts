// Same inputs must yield the same day-one prior as crates/calibration-native
// propagate_priors, including a rejected cycle and a duplicated edge.
// Skip-if-absent: the .node is built by the parity lane, not the unit lane.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DayOnePrereqEdge,
  dayOnePropagationFailureReason,
  propagateDayOnePriors,
} from './day-one-prior-propagate';

const NODE_PATH = resolve('crates/calibration-native/calibration-native.node');

interface RustPosterior {
  probs: number[];
  evidence: number;
  weakestPrereqId?: number | null;
  weakestPrereqMastery?: number | null;
}
interface PropagateAddon {
  propagatePriors(
    kcIds: number[],
    prereqEdges: DayOnePrereqEdge[],
    bPerKc: number[],
    domainThetaGlobal: number[],
    shrinkCoeff: number,
  ): RustPosterior[];
}

function loadAddon(): PropagateAddon | null {
  if (!existsSync(NODE_PATH)) return null;
  try {
    return createRequire(import.meta.url)(NODE_PATH) as PropagateAddon;
  } catch {
    return null;
  }
}

const addon = loadAddon();
if (process.env.REQUIRE_RUST_PARITY === '1' && !addon) {
  throw new Error('REQUIRE_RUST_PARITY=1 requires a loadable day-one prior native addon');
}
const d = addon ? describe : describe.skip;

interface GraphCase {
  name: string;
  kcIds: number[];
  edges: DayOnePrereqEdge[];
  b: number[];
  theta: number[];
  shrink: number;
  cycle: boolean;
}

const graphs: GraphCase[] = [
  {
    name: 'duplicate edge',
    kcIds: [0, 1],
    edges: [
      { prereqIdx: 0, depIdx: 1 },
      { prereqIdx: 0, depIdx: 1 },
    ],
    b: [0, 0],
    theta: [0, 0],
    shrink: 1,
    cycle: false,
  },
  {
    name: 'cycle',
    kcIds: [0, 1],
    edges: [
      { prereqIdx: 0, depIdx: 1 },
      { prereqIdx: 1, depIdx: 0 },
    ],
    b: [0, 0],
    theta: [0, 0],
    shrink: 1,
    cycle: true,
  },
  {
    name: 'two prerequisites',
    kcIds: [100, 200, 300],
    edges: [
      { prereqIdx: 0, depIdx: 2 },
      { prereqIdx: 1, depIdx: 2 },
    ],
    b: [-5, 5, 0],
    theta: [0, 0, 0],
    shrink: 1,
    cycle: false,
  },
  {
    name: 'tied prerequisites',
    kcIds: [100, 200, 300],
    edges: [
      { prereqIdx: 1, depIdx: 2 },
      { prereqIdx: 0, depIdx: 2 },
    ],
    b: [3, 3, 0],
    theta: [0, 0, 0],
    shrink: 1,
    cycle: false,
  },
];

d('day-one prior propagation matches the Rust reference', () => {
  const rust = addon as PropagateAddon;

  // @invariant grading: the day-one DAG prior matches Rust on the same inputs, including a cycle and a duplicate edge
  // @fails-if Kahn order, duplicate-edge dedup, probabilistic-AND, or weakest-prereq attribution diverges, or a cycle is accepted
  it('agrees on one table of graphs, including a cycle and a duplicate edge', () => {
    for (const row of graphs) {
      const ts = propagateDayOnePriors({
        kcIds: row.kcIds,
        prereqEdges: row.edges,
        bPerKc: row.b,
        domainThetaGlobal: row.theta,
        shrinkCoeff: row.shrink,
      });
      if (row.cycle) {
        expect(ts.ok, row.name).toBe(false);
        if (ts.ok) continue;
        const reason = dayOnePropagationFailureReason(ts.failure);
        expect(reason, row.name).toMatch(/cycle/);
        expect(
          () => rust.propagatePriors(row.kcIds, row.edges, row.b, row.theta, row.shrink),
          row.name,
        ).toThrow(reason);
        continue;
      }
      expect(ts.ok, row.name).toBe(true);
      if (!ts.ok) continue;
      const native = rust.propagatePriors(row.kcIds, row.edges, row.b, row.theta, row.shrink);
      expect(native.length, row.name).toBe(ts.posteriors.length);
      for (let kc = 0; kc < ts.posteriors.length; kc++) {
        const left = ts.posteriors[kc];
        const right = native[kc];
        expect(right, `${row.name}[${kc}]`).toBeTruthy();
        if (!left || !right) continue;
        expect(right.evidence, row.name).toBe(0);
        expect(left.evidence, row.name).toBe(0);
        expect(left.probs.length, row.name).toBe(right.probs.length);
        for (let i = 0; i < left.probs.length; i++) {
          expect(Object.is(left.probs[i], right.probs[i]), `${row.name}[${kc}][${i}]`).toBe(true);
        }
        expect(left.weakestPrereqId ?? null, row.name).toBe(right.weakestPrereqId ?? null);
        expect(
          Object.is(left.weakestPrereqMastery ?? null, right.weakestPrereqMastery ?? null),
          row.name,
        ).toBe(true);
      }
    }
  });
});
