// A5 (YUK-441) — graph-Laplacian smoothing prior over per-KC ability θ̂.
//
// Pure, cross-subject. An unobserved KC's estimate is pulled toward observed
// neighbours along related_to edges, while direct evidence dominates for observed
// KCs. Constraints:
//   1. Proper GMRF θ ~ N(μ₀, (λL + κI)⁻¹). The bare λL prior is improper: L has a
//      constant null space, so the κI ridge is what makes the level identifiable.
//   2. Only symmetric related_to edges enter. contrasts_with is a reverse signal and
//      prerequisite is directed (A6); the caller filters relation_type.
//   3. Mean only. Posterior variance is not returned until the V-A5-LOKO gate shows
//      the shrunk variance is calibrated.
//   4. λ→0 returns independent per-KC estimates; with κ→0 observed nodes are identity.
//
// λ/κ are owner-supplied fixed priors, not cross-learner fits, and stay dark behind
// GRAPH_LAPLACIAN_ENABLED until V-A5-LOKO tuning.

/**
 * Dark flag for A5 smoothing. False leaves getMasteryProjection byte-identical (no
 * neighbour fetch, no smoothing); the wiring is already live behind the flag.
 */
export const GRAPH_LAPLACIAN_ENABLED = false;

/**
 * Smoothing strength λ. Larger borrows more from neighbours but can flatten real
 * per-KC differences; owner-fixed pending V-A5-LOKO tuning.
 */
export const GRAPH_LAPLACIAN_LAMBDA = 0.5;

/**
 * Properness ridge κ. Anchors the otherwise-unidentifiable level of unobserved
 * islands; must be > 0 whenever a node is unobserved. Small so observed KCs barely
 * shrink.
 */
export const GRAPH_LAPLACIAN_KAPPA = 0.01;

/**
 * Per-component node cap for the dense O(n³) solve. A component larger than this is
 * left unsmoothed so a whole-tree read cannot hit the scalability cliff. Owner-fixed
 * conservative value; flag dark means it never fires today.
 */
export const GRAPH_SMOOTH_COMPONENT_CAP = 256;

/** A symmetric related_to edge. */
export interface SymmetricEdge {
  a: string;
  b: string;
  /** edge confidence ∈ (0,1]; modulates smoothing strength. Defaults to 1. */
  weight?: number;
}

/** The weighted graph Laplacian L over an ordered node set. */
export interface LaplacianSystem {
  /** node id → its row/column index in {@link L}. */
  nodeIds: string[];
  /** n×n weighted graph Laplacian: symmetric, PSD, row-sums zero. */
  L: number[][];
}

/**
 * Build L = D_deg − W from the symmetric edges whose endpoints are both in
 * `nodeIds`. Out-of-set endpoints, self-loops and non-positive weights are skipped;
 * parallel edges accumulate.
 */
export function buildLaplacian(nodeIds: string[], edges: SymmetricEdge[]): LaplacianSystem {
  const n = nodeIds.length;
  const index = new Map<string, number>();
  nodeIds.forEach((id, i) => index.set(id, i));
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const e of edges) {
    if (e.a === e.b) continue; // self-loop contributes nothing to a Laplacian
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i === undefined || j === undefined) continue; // endpoint outside node set
    const w = e.weight ?? 1;
    if (!(w > 0)) continue; // non-positive / NaN weight skipped
    L[i][j] -= w;
    L[j][i] -= w;
    L[i][i] += w;
    L[j][j] += w;
  }
  return { nodeIds, L };
}

/** Inputs to the proper-GMRF posterior-mean solve. */
export interface GmrfInput {
  /** ordered node set — MUST match {@link LaplacianSystem.nodeIds} of `L`. */
  nodeIds: string[];
  /** observed θ̂ per node. A node ABSENT here is treated as unobserved (latent). */
  thetaHat: Map<string, number>;
  /**
   * per-node observation precision dₖ (Fisher info / evidence weight). A node ABSENT
   * here, or with dₖ ≤ 0, is unobserved → it borrows entirely from the prior + graph.
   * Larger dₖ ⇒ θ̃ₖ sticks closer to θ̂ₖ (direct likelihood dominates smoothing).
   */
  observationPrecision: Map<string, number>;
  /** the weighted graph Laplacian L from {@link buildLaplacian}. */
  L: number[][];
  /** graph smoothing strength λ ≥ 0. λ=0 ⇒ diagonal system (independent / 退回独立). */
  lambda: number;
  /** properness ridge κ ≥ 0. Must be > 0 if any node is unobserved (else singular). */
  kappa: number;
  /** prior mean μ₀ (uniform). Default 0 — the cold-start θ. */
  priorMean?: number;
}

/**
 * Proper-GMRF posterior mean only (constraint 3). Solves the SPD system
 * (D + λL + κI) θ̃ = D θ̂ + κ μ₀·1, where D is the observation-precision diagonal.
 * λ=0 gives the independent shrink; λ>0 lets unobserved nodes borrow through L.
 */
export function gmrfPosteriorMean(input: GmrfInput): Map<string, number> {
  const { nodeIds, thetaHat, observationPrecision, L, lambda, kappa } = input;
  const mu0 = input.priorMean ?? 0;
  const n = nodeIds.length;
  // A = D + λL + κI ; rhs = D θ̂ + κ μ₀
  const A: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => lambda * L[i][j]),
  );
  const rhs = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const id = nodeIds[i];
    const d = Math.max(observationPrecision.get(id) ?? 0, 0);
    const obs = thetaHat.get(id);
    A[i][i] += d + kappa;
    rhs[i] = d * (obs ?? mu0) + kappa * mu0;
  }
  const solution = solveDense(A, rhs);
  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) out.set(nodeIds[i], solution[i]);
  return out;
}

/**
 * Convenience wrapper: build L and return the GMRF posterior mean. λ=0 equals the
 * independent shrink.
 */
export function smoothTheta(
  nodeIds: string[],
  edges: SymmetricEdge[],
  thetaHat: Map<string, number>,
  observationPrecision: Map<string, number>,
  lambda: number,
  kappa: number,
  priorMean = 0,
): Map<string, number> {
  const { L } = buildLaplacian(nodeIds, edges);
  return gmrfPosteriorMean({
    nodeIds,
    thetaHat,
    observationPrecision,
    L,
    lambda,
    kappa,
    priorMean,
  });
}

/** Result of a component partition. */
export interface ComponentPartition {
  /** connected components; every node in exactly one. */
  components: string[][];
  /**
   * Admitted edges per component, index-aligned. An edge lands in the component of
   * its endpoints when both are in `nodeIds` and share a root; within a bucket the
   * original order is preserved so Laplacian float accumulation is bit-identical.
   */
  componentEdges: SymmetricEdge[][];
}

/**
 * Partition `nodeIds` into connected components and bucket admitted edges in one
 * O(E) pass. Edges union nodes only when both endpoints are in `nodeIds`, a≠b, and
 * weight>0, matching buildLaplacian's admission.
 */
export function partitionByComponent(
  nodeIds: string[],
  edges: SymmetricEdge[],
): ComponentPartition {
  const parent = new Map<string, string>();
  for (const id of nodeIds) parent.set(id, id);
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    // Path-compress.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of edges) {
    if (e.a === e.b) continue;
    if (!parent.has(e.a) || !parent.has(e.b)) continue; // endpoint outside node set
    const w = e.weight ?? 1;
    if (!(w > 0)) continue;
    union(e.a, e.b);
  }
  // Group nodes by root in first-seen order (identical ordering to the old groups Map).
  const rootIndex = new Map<string, number>();
  const components: string[][] = [];
  for (const id of nodeIds) {
    const root = find(id);
    let idx = rootIndex.get(root);
    if (idx === undefined) {
      idx = components.length;
      rootIndex.set(root, idx);
      components.push([]);
    }
    components[idx].push(id);
  }
  // ONE O(E) pass: route each edge whose endpoints share a component into that bucket.
  const componentEdges: SymmetricEdge[][] = components.map(() => []);
  for (const e of edges) {
    if (!parent.has(e.a) || !parent.has(e.b)) continue; // endpoint outside node set
    const ra = find(e.a);
    if (ra !== find(e.b)) continue; // cross-component (its only tie was a non-uniting edge)
    const idx = rootIndex.get(ra);
    if (idx !== undefined) componentEdges[idx].push(e);
  }
  return { components, componentEdges };
}

/**
 * Connected components over the symmetric edge graph. Thin wrapper over
 * partitionByComponent; isolated nodes are singletons.
 */
export function connectedComponents(nodeIds: string[], edges: SymmetricEdge[]): string[][] {
  return partitionByComponent(nodeIds, edges).components;
}

/** The result of a component-partitioned smooth (YUK-559 / S4). */
export interface ComponentSmoothResult {
  /** posterior mean θ̃ per node (identical to a whole-set solve for under-cap components). */
  theta: Map<string, number>;
  /** sizes of components that EXCEEDED the cap and were left UN-smoothed (fail-safe). */
  skippedComponentSizes: number[];
  /** sizes of ALL components (observability — the RP8 scale histogram source). */
  componentSizes: number[];
}

/**
 * Component-partitioned smooth. The precision is block-diagonal across components, so
 * per-component solves are exactly equivalent to one whole-set solve; oversized
 * components are left unsmoothed (raw θ̂, or priorMean when absent) and reported.
 */
export function smoothThetaByComponent(
  nodeIds: string[],
  edges: SymmetricEdge[],
  thetaHat: Map<string, number>,
  observationPrecision: Map<string, number>,
  lambda: number,
  kappa: number,
  componentCap: number,
  priorMean = 0,
): ComponentSmoothResult {
  const { components, componentEdges } = partitionByComponent(nodeIds, edges);
  const theta = new Map<string, number>();
  const skippedComponentSizes: number[] = [];
  const componentSizes: number[] = [];
  for (let i = 0; i < components.length; i++) {
    const component = components[i];
    componentSizes.push(component.length);
    if (component.length > componentCap) {
      // Fail-safe: skip the dense solve for an oversized component — passthrough raw θ̂.
      for (const id of component) theta.set(id, thetaHat.get(id) ?? priorMean);
      skippedComponentSizes.push(component.length);
      continue;
    }
    // `componentEdges[i]` preserves admitted-edge order, so float accumulation is identical.
    const solved = smoothTheta(
      component,
      componentEdges[i],
      thetaHat,
      observationPrecision,
      lambda,
      kappa,
      priorMean,
    );
    for (const [id, v] of solved) theta.set(id, v);
  }
  return { theta, skippedComponentSizes, componentSizes };
}

/**
 * Dense Gaussian elimination with partial pivoting. SPD here, so it is nonsingular
 * when κ>0 or every node is observed. Copies A and b; never mutates the caller.
 */
export function solveDense(A: number[][], b: number[]): number[] {
  const n = b.length;
  // Augmented copy so the caller's matrices are never mutated.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Partial pivot: largest |value| in this column at/below the diagonal.
    let pivot = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best === 0) {
      // Singular column — the system is rank-deficient (e.g. κ=0 with an unobserved
      // island). Leave this variable at the prior (0 contribution) rather than NaN.
      continue;
    }
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    // Eliminate below.
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  // Back-substitution.
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    const diag = M[row][row];
    if (diag === 0) {
      x[row] = 0; // rank-deficient row → prior mean contribution (μ₀ folded into rhs).
      continue;
    }
    let acc = M[row][n];
    for (let c = row + 1; c < n; c++) acc -= M[row][c] * x[c];
    x[row] = acc / diag;
  }
  return x;
}
