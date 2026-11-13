// Day-one prerequisite DAG prior. Same Kahn order, duplicate-edge dedup,
// probabilistic-AND and strict-< weakest attribution as
// crates/calibration-native `propagate_priors`. The 41-point support and σ are
// the shared grid functions. No answers are folded, so evidence stays 0.
// An omitted root prior is the Rust uniform root.

import { polyExp, polySigmoid } from '@/core/poly-exp';
import { GRID_THETA } from '@/core/theta-grid';

export interface DayOnePrereqEdge {
  prereqIdx: number;
  depIdx: number;
}

/** One KC after propagation. `mastery` is in this KC's own (θ_global, b) frame. */
export interface DayOneGridPosterior {
  probs: number[];
  evidence: 0;
  mastery: number;
  weakestPrereqId?: number;
  weakestPrereqMastery?: number;
}

export type DayOnePropagationFailure =
  | { kind: 'length_mismatch'; kcIds: number; bPerKc: number; domainThetaGlobal: number }
  | { kind: 'bad_shrink'; shrinkCoeff: number }
  | { kind: 'non_finite'; index: number; b: number; thetaGlobal: number }
  | { kind: 'edge_out_of_range'; prereq: number; dep: number; kcCount: number }
  | { kind: 'self_prerequisite'; index: number }
  | { kind: 'cycle' };

export type DayOnePropagation =
  | { ok: true; posteriors: DayOneGridPosterior[] }
  | { ok: false; failure: DayOnePropagationFailure };

/**
 * Root distribution. `uniform` is the Rust `propagate_priors` root.
 * `unit_precision` is a N(0, 1) offset prior, used only for a root whose
 * ability or difficulty anchor is non-zero so that anchor is not averaged
 * away across ±4 logits. Omitted means `uniform`.
 */
export type DayOneRootPrior = 'uniform' | 'unit_precision';

export interface DayOnePropagationInput {
  kcIds: readonly number[];
  prereqEdges: readonly DayOnePrereqEdge[];
  bPerKc: readonly number[];
  domainThetaGlobal: readonly number[];
  shrinkCoeff: number;
  rootPrior?: DayOneRootPrior;
}

const POINTS = GRID_THETA.length;

/** Rust `propagate_priors` reason text, so a rejected graph is the same result. */
export function dayOnePropagationFailureReason(failure: DayOnePropagationFailure): string {
  switch (failure.kind) {
    case 'length_mismatch':
      return `propagatePriors: kc_ids (${failure.kcIds}), bPerKc (${failure.bPerKc}), domainThetaGlobal (${failure.domainThetaGlobal}) must be equal length`;
    case 'bad_shrink':
      return `propagatePriors: shrinkCoeff must be finite and >= 0 (got ${failure.shrinkCoeff})`;
    case 'non_finite':
      return `propagatePriors: bPerKc/domainThetaGlobal at index ${failure.index} must be finite (got b=${failure.b}, θg=${failure.thetaGlobal})`;
    case 'edge_out_of_range':
      return `propagatePriors: edge (${failure.prereq},${failure.dep}) out of range for ${failure.kcCount} KCs`;
    case 'self_prerequisite':
      return `propagatePriors: self-prerequisite at KC index ${failure.index}`;
    case 'cycle':
      return 'propagatePriors: prereq graph has a cycle (prerequisites must be a DAG)';
  }
}

function sortUnique(values: number[]): number[] {
  values.sort((a, b) => a - b);
  let write = 0;
  for (let read = 0; read < values.length; read++) {
    if (write === 0 || values[read] !== values[write - 1]) {
      values[write] = values[read];
      write += 1;
    }
  }
  values.length = write;
  return values;
}

function uniform(): number[] {
  const mass = 1 / POINTS;
  return Array.from({ length: POINTS }, () => mass);
}

let unitPrecisionCache: number[] | null = null;

/** Discrete N(0, 1) on the frozen offset grid. Same weights for every seeded root. */
function unitPrecisionPrior(): number[] {
  if (!unitPrecisionCache) {
    const weights = Array.from({ length: POINTS }, () => 0);
    let total = 0;
    for (let i = 0; i < POINTS; i++) {
      const offset = GRID_THETA[i];
      const weight = polyExp(-0.5 * offset * offset);
      weights[i] = weight;
      total = total + weight;
    }
    if (!(total > 0)) {
      unitPrecisionCache = uniform();
    } else {
      for (let i = 0; i < POINTS; i++) weights[i] = weights[i] / total;
      unitPrecisionCache = weights;
    }
  }
  return unitPrecisionCache.slice();
}

function rootDistribution(
  rootPrior: DayOneRootPrior | undefined,
  thetaGlobal: number,
  difficulty: number,
): number[] {
  const seeded = rootPrior === 'unit_precision' && (thetaGlobal !== 0 || difficulty !== 0);
  return seeded ? unitPrecisionPrior() : uniform();
}

/** Posterior mean of the offset grid. Roots stay 0 so a symmetric prior does not nudge θ̂. */
export function dayOneAbilityOffset(post: DayOneGridPosterior): number {
  if (post.weakestPrereqId === undefined) return 0;
  let acc = 0;
  for (let i = 0; i < post.probs.length; i++) acc = acc + post.probs[i] * GRID_THETA[i];
  return acc;
}

/** E[mastery] = Σ probs·σ(θ_global + grid − b), left fold, no fused multiply-add. */
function expectedMastery(probs: readonly number[], thetaGlobal: number, b: number): number {
  let acc = 0;
  for (let i = 0; i < POINTS; i++) {
    acc = acc + probs[i] * polySigmoid(thetaGlobal + GRID_THETA[i] - b);
  }
  return acc;
}

function indexInRange(raw: number, n: number): boolean {
  return Number.isInteger(raw) && raw >= 0 && raw < n;
}

export function propagateDayOnePriors(input: DayOnePropagationInput): DayOnePropagation {
  const { kcIds, prereqEdges, bPerKc, domainThetaGlobal, shrinkCoeff, rootPrior } = input;
  const n = kcIds.length;
  if (bPerKc.length !== n || domainThetaGlobal.length !== n) {
    return {
      ok: false,
      failure: {
        kind: 'length_mismatch',
        kcIds: n,
        bPerKc: bPerKc.length,
        domainThetaGlobal: domainThetaGlobal.length,
      },
    };
  }
  if (!(Number.isFinite(shrinkCoeff) && shrinkCoeff >= 0)) {
    return { ok: false, failure: { kind: 'bad_shrink', shrinkCoeff } };
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(bPerKc[i]) || !Number.isFinite(domainThetaGlobal[i])) {
      return {
        ok: false,
        failure: {
          kind: 'non_finite',
          index: i,
          b: bPerKc[i],
          thetaGlobal: domainThetaGlobal[i],
        },
      };
    }
  }

  const prereqsOf: number[][] = Array.from({ length: n }, () => []);
  const depsOf: number[][] = Array.from({ length: n }, () => []);
  for (const edge of prereqEdges) {
    const prereq = edge.prereqIdx;
    const dep = edge.depIdx;
    if (!indexInRange(prereq, n) || !indexInRange(dep, n)) {
      return {
        ok: false,
        failure: { kind: 'edge_out_of_range', prereq, dep, kcCount: n },
      };
    }
    if (prereq === dep) {
      return { ok: false, failure: { kind: 'self_prerequisite', index: prereq } };
    }
    prereqsOf[dep].push(prereq);
    depsOf[prereq].push(dep);
  }
  for (const row of prereqsOf) sortUnique(row);
  for (const row of depsOf) sortUnique(row);

  const indeg = prereqsOf.map((row) => row.length);
  const order: number[] = [];
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  let head = 0;
  while (head < queue.length) {
    const node = queue[head];
    head += 1;
    order.push(node);
    const newly: number[] = [];
    for (const dep of depsOf[node]) {
      indeg[dep] -= 1;
      if (indeg[dep] === 0) newly.push(dep);
    }
    newly.sort((a, b) => a - b);
    for (const dep of newly) queue.push(dep);
  }
  if (order.length !== n) return { ok: false, failure: { kind: 'cycle' } };

  const mastery = Array.from({ length: n }, () => 0);
  const probs: number[][] = Array.from({ length: n }, () => []);
  const weakest: Array<{ id: number; mastery: number } | undefined> = Array.from(
    { length: n },
    () => undefined,
  );

  for (const kc of order) {
    const prereqs = prereqsOf[kc];
    if (prereqs.length === 0) {
      probs[kc] = rootDistribution(rootPrior, domainThetaGlobal[kc], bPerKc[kc]);
    } else {
      let prod = 1;
      let minMastery = Number.POSITIVE_INFINITY;
      let minId = 0;
      for (const prereq of prereqs) {
        const value = mastery[prereq];
        prod = prod * value;
        if (value < minMastery) {
          minMastery = value;
          minId = kcIds[prereq];
        }
      }
      const shrink = (1 - prod) * shrinkCoeff;
      const weights = Array.from({ length: POINTS }, () => 0);
      let total = 0;
      for (let i = 0; i < POINTS; i++) {
        const weight = polySigmoid(-shrink * GRID_THETA[i]);
        weights[i] = weight;
        total = total + weight;
      }
      if (!(total > 0)) {
        probs[kc] = uniform();
      } else {
        for (let i = 0; i < POINTS; i++) weights[i] = weights[i] / total;
        probs[kc] = weights;
      }
      weakest[kc] = { id: minId, mastery: minMastery };
    }
    mastery[kc] = expectedMastery(probs[kc], domainThetaGlobal[kc], bPerKc[kc]);
  }

  const posteriors: DayOneGridPosterior[] = [];
  for (let kc = 0; kc < n; kc++) {
    const attr = weakest[kc];
    posteriors.push({
      probs: probs[kc],
      evidence: 0,
      mastery: mastery[kc],
      weakestPrereqId: attr?.id,
      weakestPrereqMastery: attr?.mastery,
    });
  }
  return { ok: true, posteriors };
}
