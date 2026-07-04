// A5 (YUK-441) — graph-Laplacian smoothing prior over per-KC ability θ̂.
//
// Pure, no IO, cross-subject (core/ boundary). This is the load-bearing math for
// "用着用着就 firm up": an UNOBSERVED KC's ability estimate is pulled toward the
// mean of its ALREADY-OBSERVED neighbours along the knowledge graph, while a KC
// with direct evidence stays anchored to its own θ̂ (the likelihood dominates the
// smoothing prior). The 全家族最干净的 n=1 机制 — a prior over a SINGLE learner's
// ability vector, with NO cross-subject parameters (no a/slip/guess/φ).
//
// ── HARD MATH CONSTRAINTS (math dossier 2026-06-20 + YUK-441 dossier comment) ──
//
//   (1) PROPER GMRF, not the bare improper prior. The bare smoothing prior
//       `p(θ) ∝ exp(−½ λ θᵀLθ)` is IMPROPER: a graph Laplacian L has a null space
//       (constant shifts — L·c·1 = 0), so the OVERALL LEVEL is unidentifiable and
//       a fully-unobserved component never firms up to an absolute mastery. We
//       upgrade to the proper GMRF prior `θ ~ N(μ₀, (λL + κI)⁻¹)`: the κI ridge
//       makes the precision matrix positive-DEFINITE (identifiable level), anchored
//       at the prior mean μ₀.
//
//   (2) SYMMETRIC / UNDIRECTED edges ONLY. L must be symmetric PSD, so only
//       `related_to` (symmetric) edges enter. `contrasts_with` is a REVERSE signal
//       (易混项 — mixing it in would pull confusable items together and poison
//       firm-up); `prerequisite` is DIRECTED (→ A6 / prereq-propagation.ts). Both
//       are EXCLUDED from this Laplacian. The wiring layer (mastery/state.ts) is the
//       single place that filters relation_type='related_to'; this module is purely
//       structural and trusts its caller to pass symmetric edges only.
//
//   (3) SOFT LAYER — mean-only. {@link gmrfPosteriorMean} returns ONLY the posterior
//       MEAN θ̃ (the moved point estimate). It deliberately does NOT return a
//       shrunken posterior variance: until the V-A5-LOKO gate passes (MSE < λ=0
//       baseline ∧ 90% coverage ∈ [85%,95%] ∧ λ-posterior > 0), the graph-shrunk
//       variance is NOT trusted as calibrated (ADR-0035 corollary: an
//       uncalibrated-looking confidence is a soft signal masquerading as hard). The
//       caller keeps the original per-KC θ̂ standard error untouched.
//
//   (4) λ→0 退回独立. As the smoothing strength λ→0 the cross-KC coupling vanishes
//       (the system becomes diagonal — each KC solved independently); with κ→0 too
//       the observed nodes return EXACTLY to θ̂ (identity). A KC with strong direct
//       evidence (large observation precision dₖ) stays near θ̂ at ANY λ — the
//       likelihood overrides the prior ("有直证 likelihood 立刻盖过").
//
// PHASE-DEFERRED — λ/κ are conservative owner-supplied priors (n=1 admissible:
//   owner-fixed constants, NOT cross-subject fits), hardcoded behind the dark flag
//   pending V-A5-LOKO tuning. λ too large抹平 real misconception differences; κ is a
//   small properness ridge. These are placeholders, NOT calibrated truth.

/**
 * FLAG — A5 graph-Laplacian smoothing of the surfaced per-KC ability θ̂.
 *
 * Module-level const dark-ship flag (mirrors SRT_ENABLED / HIERARCHICAL_ELO_ENABLED
 * / THETA_GRID_ENABLED — NO config table, NO env). Default FALSE: getMasteryProjection
 * is BYTE-IDENTICAL to today (no neighbour fetch, no smoothing, no borrowed entries).
 * Flipping it to true is the "act flip" gated on V-A5-LOKO GO; the wiring is built +
 * electrified to live now (defer-flip, not defer-build).
 */
export const GRAPH_LAPLACIAN_ENABLED = false;

/**
 * PHASE-DEFERRED — graph smoothing strength λ (owner-supplied fixed prior).
 *
 * Larger λ ⇒ more borrowing from neighbours (faster firm-up of unobserved KCs) but
 * risks抹平 real per-KC ability differences and masking misconceptions. Conservative
 * small default; the V-A5-LOKO gate tunes it against held-out KC MSE. n=1 admissible
 * (owner-fixed constant, no cross-learner fit).
 */
export const GRAPH_LAPLACIAN_LAMBDA = 0.5;

/**
 * PHASE-DEFERRED — properness ridge κ (owner-supplied fixed prior).
 *
 * The κI term that makes the GMRF precision `λL + κI` positive-DEFINITE (constraint
 * (1)): it anchors the otherwise-unidentifiable level of a fully-unobserved component
 * to μ₀. Kept SMALL so it barely shrinks observed KCs (they are dominated by their own
 * observation precision) while still rescuing the level of unobserved islands. Must be
 * > 0 whenever any node is unobserved, else the system is singular.
 */
export const GRAPH_LAPLACIAN_KAPPA = 0.01;

/**
 * YUK-559 (S4 / RP8) — the per-connected-component node-count cap for the A5 dense GMRF
 * solve. `solveDense` is O(n³) time / O(n²) memory over the requested-induced `related_to`
 * connected component; a batch tree read (`tree.ts`, up to LOAD_TREE_SNAPSHOT_LIMIT nodes)
 * can induce a whole-tree component and hit a scalability cliff. A component LARGER than
 * this cap is left UN-smoothed (fail-safe-to-no-smoothing) so the cliff never runs.
 *
 * OWNER-FIXED, **未经数据校准的保守初值（非拟合结果）**: 256 caps a single dense solve at
 * ~1.7e7 flops. n=1 admissible (a fixed structural guard, not a cross-learner fit). The
 * true value is an owner decision (spec §7 open question 2, alongside a future sparse
 * CG solver / per-request localisation). Flag dark ⇒ this guard never fires today.
 */
export const GRAPH_SMOOTH_COMPONENT_CAP = 256;

/** A symmetric (undirected) graph edge — A5 admits ONLY these (related_to). */
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
 * Build the weighted graph Laplacian L = D_deg − W over `nodeIds`, using ONLY the
 * symmetric edges whose BOTH endpoints are in `nodeIds`. Off-diagonal Lᵢⱼ = −wᵢⱼ,
 * diagonal Lᵢᵢ = Σⱼ wᵢⱼ — so L is symmetric, PSD, and each row sums to 0 (the
 * constant null space that makes the bare prior improper; see file header (1)).
 *
 * Edges referencing a node outside `nodeIds`, self-loops (a == b), and non-positive
 * weights are skipped. Parallel edges between the same pair accumulate (their weights
 * add) — duplicate `related_to` edges reinforce smoothing rather than error.
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
 * Proper-GMRF posterior MEAN θ̃ (constraint (3): MEAN ONLY — no variance is returned).
 *
 * Model: prior θ ~ N(μ₀, (λL + κI)⁻¹); likelihood θ̂ₖ ~ N(θₖ, dₖ⁻¹) for observed k
 * (dₖ from `observationPrecision`). The posterior mean solves the SPD linear system
 *
 *     (D + λL + κI) θ̃ = D θ̂ + κ μ₀·1        (λL μ₀·1 = 0 since μ₀ is uniform)
 *
 * where D = diag(dₖ). Properties (file header):
 *   - λ=0  ⇒ (D + κI) diagonal ⇒ each θ̃ₖ = (dₖθ̂ₖ + κμ₀)/(dₖ+κ): INDEPENDENT (no
 *     neighbour coupling). With κ=0 too and dₖ>0 ⇒ θ̃ₖ = θ̂ₖ exactly (identity).
 *   - λ>0  ⇒ unobserved nodes (dₖ=0) borrow from observed neighbours through L.
 *   - dₖ → ∞ ⇒ θ̃ₖ → θ̂ₖ (direct evidence overrides the smoothing prior).
 *
 * SPD ⇒ a single dense Gaussian-elimination solve is exact and stable. COST NOTE
 * (YUK-559 / RP8 — corrects the earlier "small neighbourhoods … a few KCs" claim, which
 * was STALE for batch-read callers): the solve is O(n³) time / O(n²) memory over the
 * ENTIRE node set passed in, and the node set is REQUEST-SHAPED, not bounded — a single
 * KC page induces a ~1-hop star, but a whole-tree read (mastery/state.ts loadEdgesFor
 * Projection over up to LOAD_TREE_SNAPSHOT_LIMIT requested KCs) can pass the whole
 * related_to connected component. Callers running on request-shaped node sets MUST
 * partition by connected component and cap component size — see
 * {@link smoothThetaByComponent} + {@link GRAPH_SMOOTH_COMPONENT_CAP}.
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
 * Convenience wrapper: build L from symmetric edges and return the GMRF posterior
 * mean over `nodeIds`. λ=0 ⇒ the returned map equals the per-node independent shrink
 * (identity on observed nodes when κ=0). Pure.
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

/** The result of a component partition (YUK-559 / S4 + C3 O(E) edge bucketing). */
export interface ComponentPartition {
  /** connected components over the symmetric graph; every node in EXACTLY one. */
  components: string[][];
  /**
   * the admitted edges of each component, index-aligned with {@link components}. An edge
   * is bucketed into the component of its endpoints iff BOTH endpoints are in `nodeIds`
   * and share a root (`find(a) === find(b)`) — this is EXACTLY the `memberSet.has(a) &&
   * memberSet.has(b)` admission the previous `edges.filter(...)` used (self-loops route
   * to their node's component; a weight≤0 edge whose only-path across two components was
   * itself lands in NEITHER; out-of-set endpoints are dropped), and edges keep their
   * original relative order within each bucket → downstream Laplacian float accumulation
   * is bit-identical.
   */
  componentEdges: SymmetricEdge[][];
}

/**
 * YUK-559 (S4 + C3) — partition `nodeIds` into connected components over the SYMMETRIC
 * edge graph AND bucket the admitted edges per component in ONE O(E) pass (no per-component
 * `edges.filter`). Every node appears in EXACTLY one component; a node touched by no admitted
 * edge is its own singleton component. Only edges with BOTH endpoints in `nodeIds`, a≠b, and
 * weight>0 CONNECT nodes (union) — matching {@link buildLaplacian}'s edge admission, so the
 * component structure equals the block structure of the graph Laplacian. Pure.
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
 * YUK-559 (S4) — connected components over the SYMMETRIC edge graph. Thin wrapper over
 * {@link partitionByComponent} (public API unchanged). Every node appears in EXACTLY one
 * component; a node touched by no admitted edge is its own singleton. Pure.
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
 * YUK-559 (S4 / RP8) — component-partitioned {@link smoothTheta}. Solves each connected
 * component (over the symmetric graph) INDEPENDENTLY. This is MATHEMATICALLY IDENTICAL to
 * a single whole-set solve for all under-cap components: the GMRF precision (D + λL + κI)
 * is block-diagonal across components (no edge crosses a component; D and κI are diagonal),
 * so a per-component solve equals the whole solve restricted to that component. It is a
 * PURE equivalent rearrangement that also turns O(n³) into ΣO(nᵢ³).
 *
 * A component whose node count EXCEEDS `componentCap` is left UN-smoothed
 * (fail-safe-to-no-smoothing: those nodes keep their raw θ̂, or `priorMean` when absent)
 * and its size recorded in `skippedComponentSizes` — the request-shaped O(n³) dense-solve
 * cliff (spec RP8) never runs on a pathological component. Pure.
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
    // componentEdges[i] is EXACTLY the old `edges.filter(memberSet.has(a)&&memberSet.has(b))`
    // (same edges, original order) → buildLaplacian float accumulation is bit-identical.
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
 * Solve the dense linear system A x = b by Gaussian elimination with partial
 * pivoting. A is square n×n; the system here is SPD (D + λL + κI) so it is always
 * non-singular when κ > 0 (or when every node is observed with dₖ > 0). Pure: A and b
 * are copied, never mutated. Returns x.
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
