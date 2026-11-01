// GET /api/placement/profile?goal=<id>: the placement-done "起始档案".
//
// The placement-done "起始档案": per-KC mastery over the goal's scope, derived from the
// LIVE mastery_state projection (getMasteryProjection — the B1 single source of truth, NOT
// the deprecated knowledge_mastery view). In-scope KCs with no mastery_state row come back
// as `tested:false` (untested · 0 题). Read-only; no θ̂/FSRS writes.
//
// Scope resolution mirrors placement-start EXACTLY by sharing the same three-tier
// resolver (resolveGoalPlacementScope: tier-1 frozen non-empty → tier-2 subject live-resolve →
// tier-3 full active tree), so a cold-start goal placed via tier-2/3 reads back the KC set the
// probe was scoped over — a frozen-only read would return an EMPTY profile for
// exactly those day-one goals. Sharing the resolver is preferable to reading
// the session-persisted scope: the profile tracks the CURRENT resolved
// scope, so KCs bridged after the probe surface as honest "未测" rows instead of being pinned
// to the probe-time snapshot. Untested in-scope KCs come back as tested:false so the picture
// stays honest about coverage (subject = view, no root node).

import { eq, inArray } from 'drizzle-orm';
import { POLY_SIGMOID_ENABLED } from '@/core/poly-exp';
import type { Db } from '@/db/client';
import { goal, knowledge } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';
import { readLearnerAxisStates } from '@/kernel/records/learner-axis-state';
import type {
  PlacementProfileKc,
  PlacementProfileResponse,
  TestedPlacementProfileKc,
} from '../api/placement-contracts';
import { loadDayOnePriors } from './day-one-priors';
import { resolveGoalPlacementScope } from './placement-scope';

/** How many in-scope KCs the profile surfaces (tested first). A broad goal can scope many
 * KCs; the probe only touched a handful, so cap the list to keep the reveal legible. */
const PROFILE_KC_LIMIT = 20;

/** How many "weakest" KCs (lowest p(L)) the server surfaces for the /today card's
 * preview. Computed over the FULL evidenced set BEFORE the PROFILE_KC_LIMIT cap, so a truly weak
 * but low-evidence KC (ranked past #20 by evidence) still surfaces as weakest. */
const WEAKEST_LIMIT = 5;

export async function readPlacementProfile(
  db: Db,
  goalId: unknown,
): Promise<PlacementProfileResponse> {
  if (typeof goalId !== 'string' || !goalId) {
    throw new ApiError('validation_error', 'goal query param is required', 400);
  }

  const goalRows = await db
    .select({
      scope: goal.scope_knowledge_ids,
      subjectId: goal.subject_id,
      scopeMode: goal.scope_mode,
      title: goal.title,
    })
    .from(goal)
    .where(eq(goal.id, goalId))
    .limit(1);
  const g = goalRows[0];
  if (!g) {
    throw new ApiError('not_found', `goal ${goalId} not found`, 404);
  }

  // Shared three-tier resolution (see header) — then the profile's own hygiene
  // (trim/dedupe) on whatever tier won.
  const resolvedScope = await resolveGoalPlacementScope(db, {
    scope: g.scope,
    subjectId: g.subjectId,
    scopeMode: g.scopeMode,
  });
  const scope = Array.from(
    new Set(resolvedScope.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  if (scope.length === 0) {
    // Nothing resolvable anywhere (tier-3 found zero active KC) — honest empty profile.
    return {
      goalId,
      title: g.title,
      kcs: [],
      weakest: [],
      evidenceCount: 0,
      evidencedCount: 0,
      testedCount: 0,
      totalKcs: 0,
    };
  }

  // Projection (mastery_state SoT) + names + A11 axis descriptor + day-one priors, fanned out
  // (independent reads).
  const [proj, nameRows, axisByKc, dayOnePriors] = await Promise.all([
    getMasteryProjection(db, scope),
    db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(inArray(knowledge.id, scope)),
    // per-KC caution/speed-accuracy descriptor (display-only; absent for KCs
    // the nightly batch hasn't reached the usage gate on).
    readLearnerAxisStates(db, scope),
    // resolves null (NO-OP, no DB read) unless DAY_ONE_PRIOR_ENABLED && the
    // native binding is loadable. Null ⇒ no field added below ⇒ this response
    // stays byte-identical to today (the regression anchor).
    loadDayOnePriors(db, scope),
  ]);
  const nameById = new Map(nameRows.map((r) => [r.id, r.name]));

  const kcs: PlacementProfileKc[] = scope.map((id) => {
    const m = proj.get(id);
    const name = nameById.get(id) ?? id;
    // axis descriptor is independent of mastery: a KC may have an axis row
    // even when surfaced as untested here (the read-out attaches it either way).
    const ax = axisByKc.get(id);
    const axis = ax
      ? {
          drift_v: ax.driftV,
          boundary_a: ax.boundaryA,
          ter: ax.ter,
          n_obs: ax.nObs,
          provenance: ax.provenance,
        }
      : undefined;
    // undefined whenever dayOnePriors is null (flag off / binding absent) → key
    // never added (byte-identical-off).
    const dop = dayOnePriors?.get(id);
    if (!m) {
      const row: PlacementProfileKc = { id, name, tested: false, evidence_count: 0 };
      if (axis) row.axis = axis;
      if (dop) row.day_one_prior = dop;
      return row;
    }
    const row: PlacementProfileKc = {
      id,
      name,
      tested: true,
      evidence_count: m.evidence_count,
      theta_hat: m.theta_hat,
      theta_precision: m.theta_precision,
      theta_se: m.theta_se,
      p_l: m.mastery,
      mastery_lo: m.mastery_lo,
      mastery_hi: m.mastery_hi,
      low_confidence: m.low_confidence,
      // raw evidence for client-side bit-exact re-derivation.
      success_count: m.success_count,
      fail_count: m.fail_count,
      beta: m.beta,
      ...(axis ? { axis } : {}),
    };
    if (dop) row.day_one_prior = dop;
    return row;
  });

  // evidenceCount = evidence summed across tested KCs (a question touching multiple KCs
  // counts once per KC). It's a coverage signal, NOT a distinct-question count — a single
  // question labeled with 3 KCs contributes 3 here. Computed on the FULL kcs set, before
  // the slice below, so it reflects all evidence even when the surfaced list is truncated.
  const evidenceCount = kcs.reduce((a, k) => a + (k.tested ? k.evidence_count : 0), 0);
  // testedCount / totalKcs let the UI speak honestly (how many KCs actually have evidence)
  // and disclose truncation (totalKcs vs PROFILE_KC_LIMIT). Also computed on the full set.
  const testedCount = kcs.reduce((a, k) => a + (k.tested ? 1 : 0), 0);
  const totalKcs = kcs.length;

  // Lead with what we know: tested KCs first (most evidence), then untested. Stable
  // tie-break by id so the order is deterministic across reloads.
  kcs.sort(
    (a, b) =>
      Number(b.tested) - Number(a.tested) ||
      b.evidence_count - a.evidence_count ||
      a.id.localeCompare(b.id),
  );

  // KCs with real answer evidence (evidence_count>0), over the FULL set (before the
  // PROFILE_KC_LIMIT cap). Drives /today's preview plus /profile's deep-read reconciliation and
  // their shared honest coverage count — neither may be undercounted by the truncation of kcs,
  // nor inflated by KG-borrow soft-layer rows (evidence_count:0) that testedCount can include.
  const evidencedKcs = kcs.filter(
    (k): k is TestedPlacementProfileKc => k.tested && k.evidence_count > 0 && k.p_l !== undefined,
  );
  const evidencedCount = evidencedKcs.length;
  // "weakest" surface: lowest p(L) first, over that full evidenced set — so a truly weak but
  // low-evidence KC ranked past #20 by evidence still surfaces on both learner pages.
  const weakest = [...evidencedKcs]
    .sort((a, b) => (a.p_l ?? 1) - (b.p_l ?? 1))
    .slice(0, WEAKEST_LIMIT);

  return {
    goalId,
    title: g.title,
    kcs: kcs.slice(0, PROFILE_KC_LIMIT),
    weakest,
    evidenceCount,
    evidencedCount,
    testedCount,
    totalKcs,
    // which σ the server display used: 'poly' (shared bit-exact polynomial,
    // device re-derivation matches bit-for-bit) vs 'libm' (Math.exp, ≤1-ULP off the device
    // poly → the badge shows an honest "preview", not "drift"). Flips with POLY_SIGMOID_ENABLED.
    sigma_mode: POLY_SIGMOID_ENABLED ? 'poly' : 'libm',
  };
}
