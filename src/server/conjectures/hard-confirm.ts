// YUK-531 (A5 S4 / ADR-0036 RT1) — misconception HARD-confirm decision layer (Tier 1).
//
// The SISTER of reconcile.ts (NOT inside it — import-ring stays pure: reconcile
// imports scoring+typed-state, this imports scoring only; neither imports the other).
// This module is the DARK, pure decision/audit layer for the promote-identity axis:
// "can this evidence DISSOCIATE a HELD misconception M from a mere skill deficit S?"
// (R3 identifiability / SISM). It is built dark and NOT wired into the live accept
// path — misconception-promote.ts / conjecture-accept.ts never call it. It only makes
// the hard track REACHABLE.
//
// Tier-1 red lines (design 2026-07-01-misconception-promote-mechanism.md §6):
//   - n=1 SAFE: everything here is a COUNT, a two/three-value READ, or an ENUM. There
//     is ZERO fitted parameter — no se/sp/ρ, no Bayesian posterior, no Kish n_eff
//     arithmetic (those are Tier 2, Rust-first, DEFERRED). δ_sep / bands / windows are
//     NAMED constants (owner-tunable operating points), never learner-fitted.
//   - ND-5: this module WRITES NOTHING. It reads prediction_score/probe_result events +
//     baseline_p/p(L) facts and returns a verdict. No mastery/θ̂/p(L)/FSRS/difficulty is
//     ever touched (read-only on baseline_p is allowed).
//   - flag OFF ⇒ decideDissociation is STRUCTURALLY unable to return HARD_CONFIRM.
//   - a decisive PROBE only separates M from BASELINE, never from a rival M′ (C1-O1): with
//     no rival-separating probe in the pool the verdict is CAPPED at EMERGING, never HARD.
//   - proper-scoring reuse is the SINGLE-POINT skillScorePoint (scoring.ts); the honest
//     "beats baseline" WINDOW MEAN is Rust-owned + DEFERRED (ADR-0046). Not used here.

import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { scorePrediction } from '@/server/conjectures/scoring';

/** The canonical LOG-only score event the reconcile loop appends (reconcile.ts). */
const PREDICTION_SCORE_ACTION = 'experimental:prediction_score' as const;

// ── Tier-1 knobs (NAMED consts + owner-tunable — never learner-fitted) ───────────────

/**
 * Proper-distractor SEPARATION floor: a probe is admissible as CRUCIAL evidence only when
 * |predicted_p − baseline_p| ≥ δ_sep (the conjecture's prediction genuinely diverges from
 * the quantitative baseline, so the outcome can DISCRIMINATE held-M from缺-skill). 0.20 ≈
 * Köhn-Chiu-Wang proper-distractor separation. Owner-tunable.
 */
export const DELTA_SEP = 0.2;

/**
 * "High mastery" p(L) band for the DISCRIMINATION gate: a HELD misconception is credible only
 * when the learner errs WITH mastery in place (an error at low p(L) is缺-skill, not held-M).
 * Read as a three-value band (high / low / unknown≡null). 0.6 = owner-tunable operating point.
 */
export const HELD_M_MASTERY_BAND = 0.6;

/**
 * Independence floor. n_dedup counts DISTINCT (question_id, session_window, judge_run_id)
 * tuples so a noisy judge's self-consistency triple / rerun collapses to ONE unit and cannot
 * railroad a mint. Sits at 2 to reuse the existing recurrence floor (evidence.ts). This is a
 * DEDUP COUNT, not a Kish n_eff (that is Tier 2). Owner-tunable.
 */
export const N_DEDUP_FLOOR = 2;

/**
 * Stability floor (VanLehn bug-migration guard): a misconception that flickers in a SINGLE
 * context is a transient bug, not a stable identity. Require ≥2 distinct contexts. Owner-tunable.
 */
export const CONTEXT_SPREAD_FLOOR = 2;

/**
 * Post-promotion recency window for the {active, quiet} display band. 21d = owner-tunable.
 * This is a read-time projection, NOT a second forgetting scheduler (Tier 3, n=1 not built).
 */
export const RECENCY_ACTIVE_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * Archive-honesty map: which cause_categories denote INTUITIVE / ONTOLOGICAL misconceptions
 * that are SUPPRESSED-not-deleted (Shtulman) → archive as `dormant` (a "cure" is machine-
 * inexpressible), vs PROCEDURAL ones that can be genuinely `resolved`. Read-time projection,
 * ZERO columns. Grounded against the live subject profiles (general, wenyan, math, physics):
 * only `concept` (概念理解, present in all four) is unambiguously conceptual/ontological. Every
 * other cause — knowledge_gap, reading, memory, method, calculation, computation, expression,
 * unit / unit_error, dimension, formula, grammar, word_meaning, carelessness, time_pressure,
 * other — defaults to procedural, i.e. `resolved`. CONSERVATIVE and owner-tunable: widen this
 * set as the owner sees fit.
 */
export const DORMANT_CAUSE_CATEGORIES: ReadonlySet<string> = new Set(['concept']);

// ── Records + evidence summary ───────────────────────────────────────────────────────

/** One scored dissociation observation (mapped from a prediction_score event). */
export interface DissociationRecord {
  /** the probe question identity (probe_result_event_id) — dedup dimension 1. */
  questionId: string;
  /** session/time bucket (UTC-day default) — dedup dimension 2. */
  sessionWindow: string;
  /** judging run identity — dedup dimension 3 (reruns/self-consistency collapse). */
  judgeRunId: string;
  /** context class for contextSpread (VanLehn migration guard). */
  contextKey: string;
  /** the learner's PFA p(L) at induction — three-value read (null≡unknown). */
  baselineP: number | null;
  /** the conjecture's predicted probability of a correct answer. */
  predictedP: number;
  /** graded probe outcome (1 correct / 0 wrong). */
  outcome: 0 | 1;
  /** the probe isolates THIS misconception (conjecture.discriminating). */
  discriminating: boolean;
  /** the RESPONSE matched a distractor tag / rubric facet — NOT merely "unexpectedly wrong". */
  mDiagnostic: boolean;
  /** probe lifecycle resolution. */
  resolution: 'confirmed' | 'retired';
  /** judging instant (→ recency / asymmetry ordering). */
  judgedAt: Date;
}

/** Counts + booleans distilled from the records — the input to decideDissociation. */
export interface DissociationEvidence {
  /** distinct (question, session, judge-run) tuples — noise-collapsed independence. */
  nDedup: number;
  /** distinct contexts a discriminating manifestation appeared in. */
  contextSpread: number;
  /** count of CRUCIAL + confirmed observations (admissible held-M evidence). */
  crucialConfirmedCount: number;
  /** retired observations AFTER the last crucial-confirmed (asymmetry / falsification). */
  retiredSinceLastCrucial: number;
  /** ≥1 discriminable context exists (p(L) high AND M-diagnostic response). */
  hasDiscriminatingContext: boolean;
  /** most-recent discriminating activation instant (→ recency band), or null. */
  lastDiscriminatingActivation: Date | null;
}

// ── Pure gates ───────────────────────────────────────────────────────────────────────

/**
 * DISCRIMINATION gate (the real Tier-1 progress): a context distinguishes HELD-M from缺-skill
 * ONLY when the learner errs WITH mastery in place (p(L) high) AND the response is M-DIAGNOSTIC
 * (matches a distractor tag / rubric facet). p(L) alone would amplify high-mastery SLIPS (C1-O3),
 * so both facts are required. A null baseline (cold start) is NOT high — cannot confirm held-M.
 * Two facts, a three-value read, no accumulator.
 */
export function isDiscriminatingContext(r: {
  baselineP: number | null;
  mDiagnostic: boolean;
}): boolean {
  return r.baselineP !== null && r.baselineP >= HELD_M_MASTERY_BAND && r.mDiagnostic;
}

/**
 * isCrucial admissibility gate: the probe is admissible as CRUCIAL evidence iff it is
 * `discriminating` AND its prediction separates from the baseline by ≥ δ_sep AND the model
 * beat the baseline at THIS point (single-point skillScorePoint > 0). Reuses scoring.ts's
 * SINGLE-POINT skill — deliberately NOT the Brier window mean (Rust-deferred, ADR-0046). A
 * null baseline is inadmissible (no separation to measure).
 */
export function isCrucial(r: {
  discriminating: boolean;
  predictedP: number;
  baselineP: number | null;
  outcome: 0 | 1;
}): boolean {
  if (!r.discriminating) return false;
  if (r.baselineP === null) return false;
  if (Math.abs(r.predictedP - r.baselineP) < DELTA_SEP) return false;
  const { skillScorePoint } = scorePrediction(r.predictedP, r.baselineP, r.outcome);
  return skillScorePoint > 0;
}

/** Independence dedup key — collapses reruns / self-consistency onto one unit. */
function dedupKey(r: DissociationRecord): string {
  return `${r.questionId}::${r.sessionWindow}::${r.judgeRunId}`;
}

/**
 * Distil records into the evidence summary (PURE). Counts only — dedup set size, distinct
 * discriminating contexts, crucial-confirmed tally, and the asymmetry counter (retired AFTER
 * the last crucial-confirmed). No fitted arithmetic. Sorted by judgedAt so "since the last
 * crucial" is well defined and the recency anchor is the latest discriminating activation.
 */
export function summarizeDissociation(records: DissociationRecord[]): DissociationEvidence {
  const sorted = [...records].sort((a, b) => a.judgedAt.getTime() - b.judgedAt.getTime());
  const dedup = new Set<string>();
  const contexts = new Set<string>();
  let crucialConfirmedCount = 0;
  let retiredSinceLastCrucial = 0;
  let hasDiscriminatingContext = false;
  let lastDiscriminatingActivation: Date | null = null;

  for (const r of sorted) {
    dedup.add(dedupKey(r));
    if (isDiscriminatingContext(r)) {
      hasDiscriminatingContext = true;
      contexts.add(r.contextKey);
      lastDiscriminatingActivation = r.judgedAt;
    }
    if (r.resolution === 'confirmed' && isCrucial(r)) {
      crucialConfirmedCount += 1;
      retiredSinceLastCrucial = 0; // a fresh crucial-confirmed resets the falsification counter
    } else if (r.resolution === 'retired') {
      retiredSinceLastCrucial += 1;
    }
  }

  return {
    nDedup: dedup.size,
    contextSpread: contexts.size,
    crucialConfirmedCount,
    retiredSinceLastCrucial,
    hasDiscriminatingContext,
    lastDiscriminatingActivation,
  };
}

// ── The dark decision ────────────────────────────────────────────────────────────────

/**
 * Dissociation verdict:
 *   - HARD_CONFIRM — soft→hard upgrade is licensed (all gates + flag ON + rival probe + fresh
 *     owner confirmation). REACHABLE only; nothing wires this into the live path yet.
 *   - EMERGING     — discriminating held-M evidence is accruing but CAPPED (flag OFF, or no
 *     rival-separating probe, or no fresh owner confirm). Stays soft; renders as "emerging".
 *   - INSUFFICIENT — the gates are not met: most likely缺-skill, not a held misconception.
 */
export type DissociationVerdict = 'HARD_CONFIRM' | 'EMERGING' | 'INSUFFICIENT';

export interface DecideDissociationOpts {
  /** misconceptionHardConfirmEnabled() — flag OFF ⇒ HARD_CONFIRM is structurally impossible. */
  hardConfirmEnabled: boolean;
  /** the pool has a probe that separates M from a rival M′ (honest decisive experiment). */
  hasRivalProbe: boolean;
  /** the owner FRESHLY re-confirmed the soft→hard upgrade (never automatic). */
  ownerFreshlyConfirmed: boolean;
}

/**
 * Decide the dissociation verdict (PURE). The base gates establish that held-M is DISCRIMINABLE
 * at all (≥1 discriminating context, ≥1 crucial-confirmed, 0 retired since, n_dedup≥2,
 * contextSpread≥2). HARD additionally REQUIRES the flag ON + a rival-separating probe + a fresh
 * owner confirmation; ANY of those missing caps the verdict at EMERGING (never HARD). With the
 * flag OFF this can never return HARD_CONFIRM — structurally, not by convention.
 */
export function decideDissociation(
  ev: DissociationEvidence,
  opts: DecideDissociationOpts,
): DissociationVerdict {
  const gatesMet =
    ev.hasDiscriminatingContext &&
    ev.crucialConfirmedCount >= 1 &&
    ev.retiredSinceLastCrucial === 0 &&
    ev.nDedup >= N_DEDUP_FLOOR &&
    ev.contextSpread >= CONTEXT_SPREAD_FLOOR;
  if (!gatesMet) return 'INSUFFICIENT';

  // Rival-probe honesty + fresh owner confirmation + flag ON, else cap at EMERGING. flag OFF
  // makes HARD_CONFIRM unreachable regardless of evidence strength.
  if (opts.hardConfirmEnabled && opts.hasRivalProbe && opts.ownerFreshlyConfirmed) {
    return 'HARD_CONFIRM';
  }
  return 'EMERGING';
}

// ── Read-time projections (0 columns) ─────────────────────────────────────────────────

/**
 * Post-promotion recency band from the last discriminating activation (read-time projection,
 * NOT stored). Never a forgetting scheduler — just active/quiet for display.
 */
export function recencyBand(
  lastDiscriminatingActivation: Date | null,
  now: Date,
): 'active' | 'quiet' {
  if (!lastDiscriminatingActivation) return 'quiet';
  return now.getTime() - lastDiscriminatingActivation.getTime() <= RECENCY_ACTIVE_WINDOW_MS
    ? 'active'
    : 'quiet';
}

/**
 * Archive-honesty read-time map: procedural cause → `resolved`, intuitive/ontological cause →
 * `dormant` (suppressed-not-deleted; a "cure" is machine-inexpressible). ZERO columns —
 * derived from cause_category alone. Unknown/unlisted causes default to the conservative
 * `resolved`.
 */
export function resolutionClass(causeCategory: string): 'resolved' | 'dormant' {
  return DORMANT_CAUSE_CATEGORIES.has(causeCategory) ? 'dormant' : 'resolved';
}

// ── Thin DB reader ─────────────────────────────────────────────────────────────────────

/** Default UTC-day session bucket for the dedup tuple when the event carries none. */
function utcDayWindow(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Map ONE `experimental:prediction_score` payload → a DissociationRecord, or null (fail-closed)
 * if the load-bearing scoring facts are unsound. The scoring facts (predicted_p / baseline_p /
 * outcome / resolution) are already written by the reconcile loop. The DISCRIMINATION facts
 * (`discriminating` / `m_diagnostic` / `context` / `session_window` / `judge_run_id`) are read
 * DEFENSIVELY with conservative defaults: the live reconcile loop does NOT yet stamp them
 * (distractor-tag capture is a later, non-blocking capability), so from current live data every
 * record is non-M-diagnostic ⇒ hasDiscriminatingContext stays false ⇒ decideDissociation returns
 * INSUFFICIENT. That is the intended DARK behaviour — the hard track cannot fire off today's data.
 */
function predictionScoreToRecord(
  eventId: string,
  createdAt: Date,
  payload: Record<string, unknown> | null,
): DissociationRecord | null {
  if (!payload) return null;
  const predictedP = payload.predicted_p;
  const baselineP = payload.baseline_p;
  const outcome = payload.outcome;
  const resolution = payload.resolution;
  if (typeof predictedP !== 'number' || !Number.isFinite(predictedP)) return null;
  if (typeof baselineP !== 'number' || !Number.isFinite(baselineP)) return null;
  if (outcome !== 0 && outcome !== 1) return null;
  if (resolution !== 'confirmed' && resolution !== 'retired') return null;

  const probeResultId = payload.probe_result_event_id;
  const questionId =
    typeof probeResultId === 'string' && probeResultId.length > 0 ? probeResultId : eventId;
  const contextRaw = payload.context;
  const knowledgeId = payload.knowledge_id;
  const contextKey =
    typeof contextRaw === 'string' && contextRaw.length > 0
      ? contextRaw
      : typeof knowledgeId === 'string' && knowledgeId.length > 0
        ? knowledgeId
        : questionId;
  const sessionRaw = payload.session_window;
  const sessionWindow =
    typeof sessionRaw === 'string' && sessionRaw.length > 0 ? sessionRaw : utcDayWindow(createdAt);
  const judgeRaw = payload.judge_run_id;
  const judgeRunId = typeof judgeRaw === 'string' && judgeRaw.length > 0 ? judgeRaw : eventId;

  return {
    questionId,
    sessionWindow,
    judgeRunId,
    contextKey,
    baselineP,
    predictedP,
    outcome,
    discriminating: payload.discriminating === true,
    mDiagnostic: payload.m_diagnostic === true,
    resolution,
    judgedAt: createdAt,
  };
}

/**
 * Gather dissociation evidence for one KC (PURE-READ, no writes). Reads the KC's
 * `experimental:prediction_score` events, maps each to a DissociationRecord (fail-closed),
 * and distils the count summary. Never touches mastery/θ̂/FSRS (ND-5); only reads baseline_p
 * off the LOG events. Structurally cannot confirm hard from today's un-tagged data (see
 * predictionScoreToRecord).
 */
export async function gatherDissociationEvidence(
  db: Db,
  params: { knowledgeId: string },
): Promise<DissociationEvidence> {
  const rows = await db
    .select({ id: event.id, payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.action, PREDICTION_SCORE_ACTION),
        sql`${event.payload}->>'knowledge_id' = ${params.knowledgeId}`,
      ),
    )
    .orderBy(event.created_at);

  const records: DissociationRecord[] = [];
  for (const r of rows) {
    const rec = predictionScoreToRecord(
      r.id,
      r.created_at,
      r.payload as Record<string, unknown> | null,
    );
    if (rec) records.push(rec);
  }
  return summarizeDissociation(records);
}
