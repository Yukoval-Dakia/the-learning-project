// YUK-513 Phase 2 (#123 / inc-E) — dark-ship TS wiring for the Rust `propagatePriors`
// kernel (crates/calibration-native). Joins the THETA_GRID_ENABLED / POLY_SIGMOID_ENABLED
// dark-ship family: gated by a module-const flag (PREREQ_PROPAGATION_ENABLED, defined in
// @/core/theta-grid), default FALSE — so flag-off is BYTE-IDENTICAL to today. The JS path
// stays the always-on live path; this new Rust kernel ships dark with no UI consumer (PR-3).
//
// What it does when ON: for a goal's KC scope, propagate a deterministic day-one (n=0)
// mastery prior over the `prerequisite` sub-DAG — each KC's prior is shrunk toward lower
// ability by the probabilistic-AND of its prerequisites' expected mastery (ALEKS / Knowledge
// Space Theory surmise relation), plus the weakest-prerequisite attribution.
//
// PURE TOPOLOGY (day-one modeling decision — documented, owner-reversible while dark):
//   At literal n=0 we have NO per-user evidence and NO per-KC calibrated difficulty, so
//   b = 0 and θ_global = 0 for EVERY KC. The prior therefore reflects PREREQ STRUCTURE
//   ALONE (graph depth + conjunction) — which is exactly what inc-E is ("propagate mastery
//   risk along prereq edges"). This makes day_one_prior a pure deterministic function of
//   (scope, prereq edges, shrink_coeff): perfectly reproducible, and trivially the
//   byte-identical-off regression anchor. Difficulty-aware per-KC b is a FUTURE refinement
//   (the `knowledge` table carries NO difficulty column today — only `question.difficulty`;
//   aggregating question-level b anchors to a KC-level anchor is deferred until a live
//   consumer needs it). θ_global stays 0 so the prior is user-INDEPENDENT: the "what we'd
//   have assumed from structure alone, before any answer" baseline, orthogonal to the live
//   θ̂ the placement probe writes.
//
// n=1 RED LINE (DROP-7): reads nothing per-user, estimates no item parameters; shrink_coeff
// is an owner-fixed const, NEVER population-fit.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { polySigmoid } from '@/core/poly-exp';
import { GRID_THETA, PREREQ_PROPAGATION_ENABLED } from '@/core/theta-grid';
import type { Db } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';

// ── Owner-fixed shrink coefficient — the single tunable knob of the kernel. NEVER estimated
//    from data (n=1 red line / locked item parameters): it scales how hard a prereq gap pulls
//    a dependent KC's prior down (s = gap · shrink_coeff; weight_i = σ(−s·θ)). 1.0 = neutral
//    documented default (gap maps directly to the logit tilt). Owner-tunable; not derived. ──
export const DAY_ONE_SHRINK_COEFF = 1.0;

// ── Hand-declared napi surface. The crate ships no committed .d.ts (build artifact), so we
//    mirror the parity tests (native-parity.unit.test.ts:27-55) and declare it by hand. Must
//    stay in lockstep with crates/calibration-native/src/lib.rs `propagate_priors`. ──
interface NativePrereqEdge {
  prereqIdx: number;
  depIdx: number;
}
interface NativeGridPosterior {
  probs: number[];
  evidence: number;
  // napi maps Rust Option<f64>/<u32> None → JS `undefined`.
  weakestPrereqId?: number;
  weakestPrereqMastery?: number;
}
interface PropagateAddon {
  propagatePriors(
    kcIds: number[],
    prereqEdges: NativePrereqEdge[],
    bPerKc: number[],
    domainThetaGlobal: number[],
    shrinkCoeff: number,
  ): NativeGridPosterior[];
}

// ── skip-if-absent loader (mirror native-parity.unit.test.ts:57-73). The .node is an OPT-IN
//    dev/CI build artifact (`pnpm build:native`); in any runtime without it (incl. prod
//    today) this resolves null and the whole surface NO-OPs — the live path is unaffected. ──
const NODE_PATH = resolve('crates/calibration-native/calibration-native.node');
function loadAddon(): PropagateAddon | null {
  if (!existsSync(NODE_PATH)) return null;
  try {
    return createRequire(import.meta.url)(NODE_PATH) as PropagateAddon;
  } catch {
    // exists but fails to dlopen (Node-ABI / platform mismatch / stale artifact) → treat as
    // absent. A load failure must never break the live read; the JS path is production.
    return null;
  }
}
const addon: PropagateAddon | null = loadAddon();

/** A KC's day-one (n=0) propagated mastery prior + weakest-prerequisite attribution. */
export interface DayOnePrior {
  /** Expected mastery probability of this KC's day-one prior: Σ probs·σ(θg+grid−b). With the
   *  day-one inputs (θg = b = 0) this is Σ probs·σ(GRID_THETA), computed via the SHARED poly σ
   *  so it equals the Rust kernel's internal E_mastery for this KC bit-for-bit. A display-tier
   *  scalar (the "inferred-low" magnitude PR-3 reads), NOT a live θ̂. */
  mean_mastery: number;
  /** The weakest prerequisite KC id (argmin E_mastery) — the short-board PR-3 names in the
   *  "⚠️ inferred-low — weakest prereq: X" badge. Absent for a root KC (no prerequisites). */
  weakest_prereq_id?: string;
  /** That weakest prerequisite's E_mastery ∈(0,1). Absent for a root KC. */
  weakest_prereq_mastery?: number;
}

/**
 * Day-one propagated mastery priors over a goal's KC `scope`, keyed by knowledge_id.
 *
 * Returns null (NO-OP) when the flag is OFF, the native binding is ABSENT, or the scope is
 * EMPTY — callers then simply omit the surface, leaving the response byte-identical to today.
 * PURE topology: b = 0, θ_global = 0, shrink_coeff = DAY_ONE_SHRINK_COEFF for every KC (see
 * file header). The only DB read is the active `prerequisite` edges within scope.
 */
export async function loadDayOnePriors(
  db: Db,
  scope: string[],
): Promise<Map<string, DayOnePrior> | null> {
  // Flag/binding checked FIRST so flag-off short-circuits before ANY DB read (the dark-ship
  // contract: a present binding must not change behaviour while the flag is off).
  if (!PREREQ_PROPAGATION_ENABLED || !addon) return null;

  const ids = Array.from(new Set(scope.map((s) => s.trim()).filter((s) => s.length > 0)));
  if (ids.length === 0) return null;

  // Active `prerequisite` edges with BOTH endpoints in scope. Direction: from = prerequisite,
  // to = dependent (topology-gate.ts buildPrerequisiteAdjacency builds adj[from] ⊇ {to} as the
  // learning-order successor map). archived_at IS NULL = live edges only.
  const edgeRows = await db
    .select({
      from: knowledge_edge.from_knowledge_id,
      to: knowledge_edge.to_knowledge_id,
    })
    .from(knowledge_edge)
    .where(
      and(
        eq(knowledge_edge.relation_type, 'prerequisite'),
        isNull(knowledge_edge.archived_at),
        inArray(knowledge_edge.from_knowledge_id, ids),
        inArray(knowledge_edge.to_knowledge_id, ids),
      ),
    );

  const indexOf = new Map(ids.map((id, i) => [id, i]));
  const prereqEdges: NativePrereqEdge[] = [];
  for (const e of edgeRows) {
    const p = indexOf.get(e.from);
    const d = indexOf.get(e.to);
    // Defensive: the inArray already scopes both endpoints, so this never drops a row in
    // practice; it just narrows the types from `number | undefined` to `number`.
    if (p === undefined || d === undefined) continue;
    prereqEdges.push({ prereqIdx: p, depIdx: d });
  }

  // The kernel echoes attribution by the numeric kc_id it was given; pass indices 0..n-1 so a
  // returned weakestPrereqId maps straight back to ids[]. Day-one inputs: b = 0, θg = 0.
  const kcIds = ids.map((_, i) => i);
  const zeros = ids.map(() => 0);
  const posteriors = addon.propagatePriors(kcIds, prereqEdges, zeros, zeros, DAY_ONE_SHRINK_COEFF);
  // The kernel returns exactly one GridPosterior per KC in input order. A shorter array means a
  // stale/drifted binding — fail loudly rather than silently drop KCs from the surface (matches
  // the crate's loud-input idiom: solve_theta_one_kc / forward_auc reject bad input up front).
  if (posteriors.length !== ids.length) {
    throw new Error(
      `propagatePriors returned ${posteriors.length} posteriors for ${ids.length} KCs (binding drift)`,
    );
  }

  const out = new Map<string, DayOnePrior>();
  for (let i = 0; i < ids.length; i++) {
    const post = posteriors[i];
    if (!post) continue;
    const widx = post.weakestPrereqId;
    out.set(ids[i], {
      mean_mastery: meanMastery(post.probs),
      // widx may be 0 (a valid index) → guard on `undefined`, not falsiness.
      weakest_prereq_id: widx === undefined ? undefined : ids[widx],
      weakest_prereq_mastery: post.weakestPrereqMastery,
    });
  }
  return out;
}

/** Σ probs·σ(GRID_THETA) — the day-one (θg = b = 0) expected mastery probability, via the
 *  shared poly σ so it equals the Rust kernel's internal E_mastery for this KC bit-for-bit. */
function meanMastery(probs: number[]): number {
  // Reject a non-GRID_POINTS pmf loudly: folding a non-renormalized prefix would yield a
  // plausible-but-wrong scalar with no signal (the binding-drift class the Rust side guards
  // with debug_assert_eq! in e_mastery_of). The kernel contract guarantees length GRID_POINTS.
  if (probs.length !== GRID_THETA.length) {
    throw new Error(
      `propagatePriors returned a ${probs.length}-length pmf; expected ${GRID_THETA.length} (binding drift)`,
    );
  }
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i] * polySigmoid(GRID_THETA[i]);
  }
  return acc;
}
