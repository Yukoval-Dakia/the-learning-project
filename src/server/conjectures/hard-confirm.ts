// YUK-531 (A5 S4 / ADR-0036 RT1) — misconception HARD-confirm decision layer (Tier 1).
//
// The SISTER of reconcile.ts (NOT inside it — import-ring stays pure: reconcile
// imports scoring+typed-state, this imports scoring only; neither imports the other).
// This module is the pure decision/read layer for the promote-identity axis:
// "can this evidence DISSOCIATE a HELD misconception M from a mere skill deficit S?"
// (R3 identifiability / SISM). YUK-795 wires the batch reader + verdict into the
// nightly prediction-accountability ranker. The hard-label mutation itself remains
// fail-closed: a soft→hard flip still demands a FRESH owner confirmation at a
// dedicated command and is never inferred from the nightly pass.
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

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getEffectiveProbeResultStatuses } from '@/capabilities/agency/public';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { scorePrediction } from '@/server/conjectures/scoring';

/** The canonical score fact the reconcile loop appends (reconcile.ts). */
const PREDICTION_SCORE_ACTION = 'experimental:prediction_score' as const;
/** Score-free terminal recurrence projection appended by reconcile.ts. */
const PROBE_RESULT_PROJECTED_ACTION = 'experimental:probe_result_projected' as const;

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
 * ZERO columns. Grounded against the live subject profiles (general, yuwen, math, physics):
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
  /** the prediction_score event identity (audit/ref provenance). */
  scoreEventId: string;
  /** the conjecture proposal that made the prediction. */
  conjectureEventId: string;
  /** the backing probe_result event identity. */
  probeResultEventId: string;
  /** probe question identity (probe_question_id; fallback probe_result_event_id) — dedup axis 1. */
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
  resolution: 'evidence_for' | 'confirmed' | 'retired';
  /** score source instant; prediction-accountability streaks stay ordered by this. */
  scoredAt: Date;
  /** effective evidence instant (terminal confirmation time when recurrence confirms sequence 1). */
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

// ── Tier-1 decision ─────────────────────────────────────────────────────────────────

/**
 * Dissociation verdict:
 *   - HARD_CONFIRM — soft→hard upgrade is licensed (all gates + flag ON + rival probe + fresh
 *     owner confirmation). The nightly ranker always passes ownerFreshlyConfirmed=false,
 *     so it can observe EMERGING but never perform the protected label mutation.
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
 * DEFENSIVELY with conservative defaults. Reconcile stamps the facts it genuinely owns;
 * `m_diagnostic` stays false unless an upstream Judge explicitly supplied it. A plain wrong
 * answer is never promoted into target-error evidence by inference.
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
  // baseline_p is a LOAD-BEARING scoring fact — DROPPED fail-closed (whole record) on any
  // null/NaN/±Infinity/non-number, NOT passed through as the three-value null. The live producer
  // (reconcile.ts) always writes it from baseline_p_at_induction = z.number().min(0).max(1), so a
  // null here is ONLY an anomaly (manual edit / drift), never a legitimate cold start. The
  // `baselineP: number | null` record type is defense-in-depth INSIDE the gates
  // (isDiscriminatingContext/isCrucial read null as non-discriminating and never crash), NOT a
  // signal to synthesize null records: a null baseline can never be crucial/discriminating, so
  // KEEPing it would only let an anomaly inflate the n_dedup independence AND-gate for zero real
  // signal. DROP = strictly safer; KEEP = weaken-fail-closed-for-nothing (Finding-2, kept as-is).
  if (typeof baselineP !== 'number' || !Number.isFinite(baselineP)) return null;
  if (outcome !== 0 && outcome !== 1) return null;
  if (resolution !== 'evidence_for' && resolution !== 'confirmed' && resolution !== 'retired') {
    return null;
  }

  const probeResultId = payload.probe_result_event_id;
  const conjectureEventId = payload.conjecture_event_id;
  if (typeof probeResultId !== 'string' || probeResultId.length === 0) return null;
  if (typeof conjectureEventId !== 'string' || conjectureEventId.length === 0) return null;
  const questionId =
    typeof payload.probe_question_id === 'string' && payload.probe_question_id.length > 0
      ? payload.probe_question_id
      : probeResultId;
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
    scoreEventId: eventId,
    conjectureEventId,
    probeResultEventId: probeResultId,
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
    scoredAt: createdAt,
    judgedAt: createdAt,
  };
}

/** The (cause_category × knowledge_id) IDENTITY a conjecture proposal asserts. */
interface ConjectureIdentity {
  cause_category: string;
  knowledge_id: string;
}

export interface ConjectureIdentityTarget {
  key: string;
  causeCategory: string;
  knowledgeId: string;
}

const MAX_ACCOUNTABILITY_KNOWLEDGE_IDS_PER_QUERY = 500;

function conjectureIdentityKey(causeCategory: string, knowledgeId: string): string {
  return `${causeCategory}\u0000${knowledgeId}`;
}

function boundedChunks<T>(values: readonly T[]): T[][] {
  const size = MAX_ACCOUNTABILITY_KNOWLEDGE_IDS_PER_QUERY;
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Recover the misconception IDENTITY (cause_category × knowledge_id) for each backing conjecture
 * (read-only JOIN, ZERO writes). A `prediction_score` payload carries `conjecture_event_id`
 * (reconcile.ts) plus its OWN `knowledge_id`, but that copy is NOT the identity source of truth;
 * the authoritative identity lives in the conjecture proposal's
 * `ai_proposal.proposed_change.{cause_category,knowledge_id}` (research_meeting_nightly.ts).
 * Batch-load the referenced proposals by id and map conjecture_event_id → identity. Fail-closed: a
 * missing / non-conjecture / malformed proposal (EITHER axis absent) yields NO entry, so its scores
 * are UN-attributable and drop out of every gather — a score we cannot attribute to a specific
 * (cause×KC) misconception must never pool into one.
 */
async function loadIdentityByConjectureId(
  db: Db,
  conjectureEventIds: Set<string>,
): Promise<Map<string, ConjectureIdentity>> {
  const out = new Map<string, ConjectureIdentity>();
  if (conjectureEventIds.size === 0) return out;
  const rowChunks = await Promise.all(
    boundedChunks([...conjectureEventIds]).map((chunk) =>
      db
        .select({ id: event.id, payload: event.payload })
        .from(event)
        .where(inArray(event.id, chunk)),
    ),
  );
  const rows = rowChunks.flat();
  for (const r of rows) {
    const identity = extractConjectureIdentity(r.payload as Record<string, unknown> | null);
    if (identity !== null) out.set(r.id, identity);
  }
  return out;
}

/**
 * Read the (cause_category, knowledge_id) IDENTITY off a conjecture proposal
 * (`ai_proposal.proposed_change`), fail-closed. BOTH axes must be present non-empty strings, else
 * null (⇒ the score is un-attributable and drops out of every gather). The knowledge_id read here
 * is the identity SOURCE OF TRUTH — the score payload's own knowledge_id is cross-checked against
 * it, never trusted alone (Finding-3 fix).
 */
function extractConjectureIdentity(
  payload: Record<string, unknown> | null,
): ConjectureIdentity | null {
  const aiProposal = (
    payload as { ai_proposal?: { kind?: unknown; proposed_change?: unknown } } | null
  )?.ai_proposal;
  if (!aiProposal || aiProposal.kind !== 'conjecture') return null;
  const change = aiProposal.proposed_change as {
    cause_category?: unknown;
    knowledge_id?: unknown;
  } | null;
  const cause = change?.cause_category;
  const kc = change?.knowledge_id;
  if (typeof cause !== 'string' || cause.length === 0) return null;
  if (typeof kc !== 'string' || kc.length === 0) return null;
  return { cause_category: cause, knowledge_id: kc };
}

/**
 * Gather dissociation evidence for ONE misconception identity = (cause_category × knowledge_id)
 * (PURE-READ, no writes). A misconception is keyed on cause×KC (misconception-promote.ts:100), so
 * this reads the KC's `experimental:prediction_score` events plus terminal score-free recurrence
 * projections, JOINS each back to its conjecture proposal (via `conjecture_event_id`) to recover
 * the proposal's AUTHORITATIVE (cause × kc) identity, and keeps ONLY anchors whose proposal
 * identity equals the requested (cause×KC). A valid terminal projection upgrades the associated
 * sequence-1 `evidence_for` score to `confirmed`; it never receives or fabricates its own score. The
 * proposal — not the score payload — is the identity source of truth on BOTH axes: because the SQL
 * pre-filter already pins score.payload.knowledge_id == params.knowledgeId, re-checking the
 * proposal's knowledge_id here CROSS-VALIDATES the two kc copies, so a mis-stamped score whose
 * conjecture points at another KC's same-cause conjecture can never sneak into this (cause×KC)
 * (Finding-3). Scores from a DIFFERENT cause OR a different kc belong to a DIFFERENT misconception
 * and must NEVER pool into this one — pooling would let two single-context rival misconceptions
 * fake a 2-context spread and forge held-M from rival-M′ evidence (violates doc C1-O1 rival-M′
 * separation + ③ VanLehn bug-migration guard). Grouping is by cause×KC, NOT by raw
 * conjecture_event_id: a later RE-INDUCTION of the same cause×KC is a fresh proposal but the SAME
 * misconception, so its scores must accrue together. Never touches mastery/θ̂/FSRS (ND-5); only
 * reads baseline_p off the score events. Structurally cannot confirm hard from today's un-tagged data
 * (see predictionScoreToRecord). The join is a query — counts/enumerates only, ZERO fitted
 * parameter (n=1 red line held).
 */
export async function gatherDissociationRecordsByIdentity(
  db: Db,
  targets: readonly ConjectureIdentityTarget[],
): Promise<Map<string, DissociationRecord[]>> {
  const out = new Map<string, DissociationRecord[]>();
  const targetKeyByIdentity = new Map<string, string>();
  const identityByTargetKey = new Map<string, string>();
  for (const target of targets) {
    const identity = conjectureIdentityKey(target.causeCategory, target.knowledgeId);
    const priorKey = targetKeyByIdentity.get(identity);
    if (priorKey !== undefined && priorKey !== target.key) {
      throw new Error(
        `Duplicate conjecture identity target ${target.causeCategory} × ${target.knowledgeId}`,
      );
    }
    const priorIdentity = identityByTargetKey.get(target.key);
    if (priorIdentity !== undefined && priorIdentity !== identity) {
      throw new Error(`Accountability target key ${target.key} maps to multiple identities`);
    }
    targetKeyByIdentity.set(identity, target.key);
    identityByTargetKey.set(target.key, identity);
    out.set(target.key, []);
  }
  if (targets.length === 0) return out;
  const knowledgeIds = [...new Set(targets.map((target) => target.knowledgeId))];
  const scoreChunks = await Promise.all(
    boundedChunks(knowledgeIds).map((chunk) =>
      db
        .select({
          id: event.id,
          action: event.action,
          payload: event.payload,
          created_at: event.created_at,
        })
        .from(event)
        .where(
          and(
            inArray(event.action, [PREDICTION_SCORE_ACTION, PROBE_RESULT_PROJECTED_ACTION]),
            sql`${event.payload}->>'knowledge_id' IN (${sql.join(
              chunk.map((knowledgeId) => sql`${knowledgeId}`),
              sql`, `,
            )})`,
          ),
        )
        .orderBy(event.created_at, event.id),
    ),
  );
  const rows: Array<{ id: string; action: string; payload: unknown; created_at: Date }> =
    scoreChunks.flat();
  rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
  const probeResultEventIds = [
    ...new Set(
      rows.flatMap((row) => {
        const probeResultEventId = (row.payload as Record<string, unknown> | null)
          ?.probe_result_event_id;
        return typeof probeResultEventId === 'string' ? [probeResultEventId] : [];
      }),
    ),
  ];
  const probeResultChunks = boundedChunks(probeResultEventIds);
  const [statusChunks, sourceTimeChunks] = await Promise.all([
    Promise.all(probeResultChunks.map((chunk) => getEffectiveProbeResultStatuses(db, chunk))),
    Promise.all(
      probeResultChunks.map((chunk) =>
        db
          .select({ id: event.id, created_at: event.created_at })
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:probe_result'),
              eq(event.subject_kind, 'question'),
              inArray(event.id, chunk),
            ),
          ),
      ),
    ),
  ]);
  const scoreStatuses = new Map(statusChunks.flatMap((statusMap) => [...statusMap.entries()]));
  const sourceCreatedAtById = new Map(
    sourceTimeChunks.flatMap((chunk) => chunk.map((row) => [row.id, row.created_at] as const)),
  );

  // Recover each score's AUTHORITATIVE identity by joining back to its conjecture proposal, then
  // keep only the rows whose proposal (cause × kc) equals the requested misconception identity.
  const conjectureEventIds = new Set<string>();
  for (const r of rows) {
    const cid = (r.payload as { conjecture_event_id?: unknown } | null)?.conjecture_event_id;
    if (typeof cid === 'string' && cid.length > 0) conjectureEventIds.add(cid);
  }
  const identityByConjectureId = await loadIdentityByConjectureId(db, conjectureEventIds);

  // Sequence 2 intentionally has no calibrated probability, so reconcile writes a
  // score-free projection instead of a prediction_score. Its immutable
  // independent_probe_question_ids lineage can nevertheless confirm the scored
  // sequence-1 observation. Fold that terminal fact onto the existing score rather
  // than fabricating a second score row.
  const confirmationTimeByConjectureAndQuestion = new Map<string, Map<string, Date>>();
  for (const r of rows) {
    if (r.action !== PROBE_RESULT_PROJECTED_ACTION) continue;
    const payload = r.payload as Record<string, unknown> | null;
    const probeResultEventId = payload?.probe_result_event_id;
    if (
      typeof probeResultEventId !== 'string' ||
      scoreStatuses.get(probeResultEventId) !== 'active' ||
      payload?.resolution !== 'confirmed'
    ) {
      continue;
    }
    const conjectureEventId = payload.conjecture_event_id;
    const knowledgeId = payload.knowledge_id;
    if (typeof conjectureEventId !== 'string' || typeof knowledgeId !== 'string') continue;
    const identity = identityByConjectureId.get(conjectureEventId);
    if (
      !identity ||
      identity.knowledge_id !== knowledgeId ||
      !targetKeyByIdentity.has(
        conjectureIdentityKey(identity.cause_category, identity.knowledge_id),
      )
    ) {
      continue;
    }
    const independentQuestionIds = payload.independent_probe_question_ids;
    if (!Array.isArray(independentQuestionIds)) continue;
    const validIds = independentQuestionIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (new Set(validIds).size < 2) continue;
    const confirmationTime = sourceCreatedAtById.get(probeResultEventId) ?? r.created_at;
    const confirmationTimes =
      confirmationTimeByConjectureAndQuestion.get(conjectureEventId) ?? new Map<string, Date>();
    for (const questionId of validIds) {
      const prior = confirmationTimes.get(questionId);
      if (!prior || confirmationTime.getTime() > prior.getTime()) {
        confirmationTimes.set(questionId, confirmationTime);
      }
    }
    confirmationTimeByConjectureAndQuestion.set(conjectureEventId, confirmationTimes);
  }

  for (const r of rows) {
    if (r.action !== PREDICTION_SCORE_ACTION) continue;
    const payload = r.payload as Record<string, unknown> | null;
    const probeResultEventId = payload?.probe_result_event_id;
    const sourceStatus =
      typeof probeResultEventId === 'string' ? scoreStatuses.get(probeResultEventId) : undefined;
    // Fail closed on legacy/unattributable scores: without a source probe-result id
    // there is no way to fold later corrections or recurrence dependencies. Such a
    // row remains in the audit log but cannot contribute to hard-confirm evidence.
    if (typeof probeResultEventId !== 'string' || sourceStatus !== 'active') {
      continue;
    }
    const cid = payload?.conjecture_event_id;
    const identity = typeof cid === 'string' ? (identityByConjectureId.get(cid) ?? null) : null;
    // Identity-scoped on the PROPOSAL (source of truth, both axes). Drop the score when it is
    // un-attributable (no resolvable proposal) OR its proposal (cause × kc) differs from the
    // requested identity — so rival causes never pool (FAIL-2) AND a mis-stamped score whose
    // payload kc disagrees with its proposal kc satisfies NEITHER pool (cross-validation against
    // the SQL kc pre-filter, Finding-3). Never trust the score payload's own knowledge_id here.
    if (identity === null) continue;
    const targetKey = targetKeyByIdentity.get(
      conjectureIdentityKey(identity.cause_category, identity.knowledge_id),
    );
    if (!targetKey) continue;
    const parsed = predictionScoreToRecord(
      r.id,
      // Legacy score anchors used the nightly batch time. Always prefer the
      // backing probe-result timestamp so old and new histories share the same
      // evidence chronology without rewriting immutable events.
      sourceCreatedAtById.get(probeResultEventId) ?? r.created_at,
      payload,
    );
    if (parsed) {
      const confirmationTime =
        parsed.resolution === 'evidence_for'
          ? confirmationTimeByConjectureAndQuestion
              .get(parsed.conjectureEventId)
              ?.get(parsed.questionId)
          : undefined;
      const confirmed = confirmationTime
        ? { ...parsed, resolution: 'confirmed' as const, judgedAt: confirmationTime }
        : parsed;
      out.get(targetKey)?.push(confirmed);
    }
  }
  return out;
}

export async function gatherDissociationEvidence(
  db: Db,
  params: { knowledgeId: string; causeCategory: string },
): Promise<DissociationEvidence> {
  const key = conjectureIdentityKey(params.causeCategory, params.knowledgeId);
  const records = await gatherDissociationRecordsByIdentity(db, [
    {
      key,
      knowledgeId: params.knowledgeId,
      causeCategory: params.causeCategory,
    },
  ]);
  return summarizeDissociation(records.get(key) ?? []);
}
