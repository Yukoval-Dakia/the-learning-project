// YUK-513 — dark-ship wiring for the Rust `propagatePriors` kernel.
//
// Gated by `DAY_ONE_PRIOR_ENABLED` (off by default), so flag-off leaves the live response
// byte-identical. When on, it propagates a day-one (n=0) mastery prior over the `prerequisite`
// sub-DAG. At n=0 there is no per-user or per-KC difficulty evidence, so the prior reflects
// topology alone (b = 0, θ_global = 0): a user-independent baseline, not the live θ̂.
// shrink_coeff is owner-fixed and never population-fit; the native binding is optional and
// absent or failed loading degrades to a NO-OP rather than breaking the live read.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { polySigmoid } from '@/core/poly-exp';
import { DAY_ONE_PRIOR_ENABLED, GRID_THETA } from '@/core/theta-grid';
import type { Db } from '@/db/client';
import { knowledge_edge } from '@/db/schema';

// Owner-fixed: scales how hard a prerequisite gap pulls a dependent KC's prior down
// (s = gap · shrink_coeff; weight_i = σ(−s·θ)). Never estimated from data.
export const DAY_ONE_SHRINK_COEFF = 1.0;

// Hand-declared napi surface: the crate ships no committed .d.ts. Keep in lockstep with
// crates/calibration-native/src/lib.rs `propagate_priors`.
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

// Skip-if-absent loader. The .node is an opt-in dev/CI artifact (`pnpm build:native`);
// production has none, so this resolves null and the surface NO-OPs. The path is
// cwd-relative to match the parity-test loader and the esbuild bundle, so deploying the
// binding needs a deployment-aware loader first.
const NODE_PATH = resolve('crates/calibration-native/calibration-native.node');
function loadAddon(): PropagateAddon | null {
  if (!existsSync(NODE_PATH)) return null;
  try {
    return createRequire(import.meta.url)(NODE_PATH) as PropagateAddon;
  } catch (err) {
    // Present but fails to dlopen (ABI / platform / stale artifact) → absent. A load failure
    // must never break the live read, but log once so a broken artifact is diagnosable.
    console.error(
      '[loadDayOnePriors] native binding present but failed to load; treating as absent',
      err,
    );
    return null;
  }
}
const addon: PropagateAddon | null = loadAddon();

/** Day-one (n=0) propagated mastery prior plus weakest-prerequisite attribution. */
export interface DayOnePrior {
  /** Expected mastery under the day-one inputs; a display-tier scalar, not a live θ̂. */
  mean_mastery: number;
  /** Weakest prerequisite (argmin); absent for a root KC. */
  weakest_prereq_id?: string;
  /** That prerequisite's expected mastery; absent for a root KC. */
  weakest_prereq_mastery?: number;
}

/** Propagated priors for a goal's KC scope, or null when disabled, unavailable, or empty. */
export async function loadDayOnePriors(
  db: Db,
  scope: string[],
): Promise<Map<string, DayOnePrior> | null> {
  // Check flag/binding first: a present binding must not change behaviour while the flag is off.
  if (!DAY_ONE_PRIOR_ENABLED || !addon) return null;

  const ids = Array.from(new Set(scope.map((s) => s.trim()).filter((s) => s.length > 0)));
  if (ids.length === 0) return null;

  // Flag-on failures (DB, native panic/cycle, binding drift) degrade to NO-OP + a log:
  // this dark-ship surface must never break the live placement-profile read.
  try {
    // Active `prerequisite` edges with both endpoints in scope (from = prerequisite, to = dependent).
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
      if (p === undefined || d === undefined) continue;
      prereqEdges.push({ prereqIdx: p, depIdx: d });
    }

    // The kernel echoes attribution by input index; pass 0..n-1 so the result maps back to ids[].
    const kcIds = ids.map((_, i) => i);
    // Keep these separate even though both are zero today: they are different inputs
    // (difficulty anchor vs global ability) and must not alias if a caller varies one.
    const bPerKc = ids.map(() => 0);
    const domainThetaGlobal = ids.map(() => 0);
    const posteriors = addon.propagatePriors(
      kcIds,
      prereqEdges,
      bPerKc,
      domainThetaGlobal,
      DAY_ONE_SHRINK_COEFF,
    );
    // A shorter array means a stale/drifted binding: throw (caught → NO-OP + log) rather
    // than silently drop KCs.
    if (posteriors.length !== ids.length) {
      throw new Error(
        `propagatePriors returned ${posteriors.length} posteriors for ${ids.length} KCs (binding drift)`,
      );
    }

    const out = new Map<string, DayOnePrior>();
    for (let i = 0; i < ids.length; i++) {
      const post = posteriors[i];
      // A hole is binding drift: throw (caught → NO-OP + log) rather than skip a KC.
      if (!post) {
        throw new Error(`propagatePriors posterior[${i}] is missing (binding drift)`);
      }
      const widx = post.weakestPrereqId;
      // Out-of-range is binding drift, not attribution. widx may legitimately be 0, so check
      // undefined + range rather than falsiness.
      const weakestId =
        widx !== undefined && widx >= 0 && widx < ids.length ? ids[widx] : undefined;
      const wm = post.weakestPrereqMastery;
      // Attribution is a unit: id and mastery surface together or not at all.
      const hasAttr = weakestId !== undefined && wm !== undefined;
      out.set(ids[i], {
        mean_mastery: meanMastery(post.probs),
        weakest_prereq_id: hasAttr ? weakestId : undefined,
        weakest_prereq_mastery: hasAttr ? wm : undefined,
      });
    }
    return out;
  } catch (err) {
    console.error('[loadDayOnePriors] native propagation failed; degrading to NO-OP', err);
    return null;
  }
}

/** Expected mastery Σ probs·σ(GRID_THETA), matching the Rust kernel bit-for-bit. */
function meanMastery(probs: number[]): number {
  // A non-GRID_POINTS pmf would fold into a plausible-but-wrong scalar; the kernel
  // contract guarantees GRID_THETA.length.
  if (probs.length !== GRID_THETA.length) {
    throw new Error(
      `propagatePriors returned a ${probs.length}-length pmf; expected ${GRID_THETA.length} (binding drift)`,
    );
  }
  // Validate the PMF itself: non-normalized or negative-but-cancelling masses can still
  // yield an in-range scalar. Anything else is binding drift, not a display value.
  let acc = 0;
  let mass = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (!Number.isFinite(p) || p < 0) {
      throw new Error(
        `propagatePriors pmf[${i}]=${p} is not a finite non-negative mass (binding drift)`,
      );
    }
    mass += p;
    acc += p * polySigmoid(GRID_THETA[i]);
  }
  // Allow a few ULP of f64 fold error.
  if (Math.abs(mass - 1) > 1e-9) {
    throw new Error(`propagatePriors pmf sums to ${mass}, not 1 (binding drift)`);
  }
  return acc;
}
