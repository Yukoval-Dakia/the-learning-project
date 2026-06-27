// GET /api/placement/profile?goal=<id> — cold-start inc-B profile read (YUK-473 Slice 4).
//
// The placement-done "起始档案": per-KC mastery over the goal's scope, derived from the
// LIVE mastery_state projection (getMasteryProjection — the B1 single source of truth, NOT
// the deprecated knowledge_mastery view). In-scope KCs with no mastery_state row come back
// as `tested:false` (untested · 0 题). Read-only; no θ̂/FSRS writes.
//
// Scope resolution mirrors placement-start: the goal's scope_knowledge_ids (subject = view,
// no root node). The probe's answers populated those KCs' mastery_state; untested in-scope
// KCs surface as the profile's "未测" rows so the picture is honest about coverage.

import { POLY_SIGMOID_ENABLED } from '@/core/poly-exp';
import { db } from '@/db/client';
import { goal, knowledge } from '@/db/schema';
import { type DayOnePrior, loadDayOnePriors } from '@/server/coldstart/propagate-priors';
import { ApiError, errorResponse } from '@/server/http/errors';
import { getMasteryProjection } from '@/server/mastery/state';
import { eq, inArray } from 'drizzle-orm';

/** How many in-scope KCs the profile surfaces (tested first). A broad goal can scope many
 * KCs; the probe only touched a handful, so cap the list to keep the reveal legible. */
const PROFILE_KC_LIMIT = 20;

export interface ProfileKc {
  id: string;
  name: string;
  tested: boolean;
  evidence_count: number;
  /** present only when tested (a mastery_state row exists). */
  theta_hat?: number;
  theta_precision?: number;
  theta_se?: number;
  p_l?: number;
  mastery_lo?: number;
  mastery_hi?: number;
  low_confidence?: boolean;
  // YUK-495 #41 — raw evidence so the client can RE-DERIVE the band bit-for-bit
  // (deriveProfileKc: pfaLogit(beta,γ,ρ,succ,fail) → σ([logit±se])). Present only when tested.
  success_count?: number;
  fail_count?: number;
  beta?: number;
  // YUK-513 #123 / inc-E — DARK day-one (n=0) propagated mastery prior over the prereq
  // sub-DAG (deterministic, user-independent: see loadDayOnePriors). Present only when
  // PREREQ_PROPAGATION_ENABLED && the native binding is loadable; otherwise the field is
  // OMITTED and this response is byte-identical to today. No UI consumer until PR-3.
  day_one_prior?: DayOnePrior;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const goalId = new URL(req.url).searchParams.get('goal');
    if (!goalId) {
      throw new ApiError('validation_error', 'goal query param is required', 400);
    }

    const goalRows = await db
      .select({ scope: goal.scope_knowledge_ids, title: goal.title })
      .from(goal)
      .where(eq(goal.id, goalId))
      .limit(1);
    const g = goalRows[0];
    if (!g) {
      throw new ApiError('not_found', `goal ${goalId} not found`, 404);
    }

    const scope = Array.from(
      new Set((g.scope ?? []).map((id) => id.trim()).filter((id) => id.length > 0)),
    );
    if (scope.length === 0) {
      // Cold goal (north-star, no resolvable scope yet) — nothing to project.
      return Response.json({
        goalId,
        title: g.title,
        kcs: [],
        evidenceCount: 0,
        testedCount: 0,
        totalKcs: 0,
      });
    }

    // Projection (mastery_state SoT) + names + day-one priors, fanned out (independent reads).
    const [proj, nameRows, dayOnePriors] = await Promise.all([
      getMasteryProjection(db, scope),
      db
        .select({ id: knowledge.id, name: knowledge.name })
        .from(knowledge)
        .where(inArray(knowledge.id, scope)),
      // YUK-513 #123 / inc-E — resolves null (NO-OP, no DB read) unless
      // PREREQ_PROPAGATION_ENABLED && the native binding is loadable. Null ⇒ no field added
      // below ⇒ this response stays byte-identical to today (the regression anchor).
      loadDayOnePriors(db, scope),
    ]);
    const nameById = new Map(nameRows.map((r) => [r.id, r.name]));

    const kcs: ProfileKc[] = scope.map((id) => {
      const m = proj.get(id);
      const name = nameById.get(id) ?? id;
      // undefined whenever dayOnePriors is null (flag off / binding absent) → key never added.
      const dop = dayOnePriors?.get(id);
      if (!m) {
        const row: ProfileKc = { id, name, tested: false, evidence_count: 0 };
        if (dop) row.day_one_prior = dop;
        return row;
      }
      const row: ProfileKc = {
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
        // YUK-495 #41 — raw evidence for client-side bit-exact re-derivation.
        success_count: m.success_count,
        fail_count: m.fail_count,
        beta: m.beta,
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

    return Response.json({
      goalId,
      title: g.title,
      kcs: kcs.slice(0, PROFILE_KC_LIMIT),
      evidenceCount,
      testedCount,
      totalKcs,
      // YUK-495 #41 — which σ the server display used: 'poly' (shared bit-exact polynomial,
      // device re-derivation matches bit-for-bit) vs 'libm' (Math.exp, ≤1-ULP off the device
      // poly → the badge shows an honest "preview", not "drift"). Flips with POLY_SIGMOID_ENABLED.
      sigma_mode: POLY_SIGMOID_ENABLED ? 'poly' : 'libm',
    });
  } catch (err) {
    return errorResponse(err);
  }
}
