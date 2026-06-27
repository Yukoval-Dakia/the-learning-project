// YUK-440 (A13) U8 — the prediction-grounding RECONCILE loop = the A13 dark-loop
// CONSUMER (U3 serveProbeOnce/answerProbe is the producer). It closes the
// collect→power loop the roadmap §5 dark-loop tripwire requires: without this,
// probe outcomes accumulate but no prediction_score ever lands and the typed-ledger
// never advances = collect-without-power = dead loop (feedback_defer_flip_not_build).
//
// Per unscored probe outcome:
//   1. join the canonical `experimental:probe_result` event to its conjecture by the
//      DIRECT `conjecture_event_id` ref (the newer canonical model supersedes the older
//      "join by KC + window" heuristic — the probe carries the exact proposal id);
//   2. scorePrediction(predicted_p, baseline_p_at_induction, outcome) — a PROPER-SCORING
//      comparison (stub; Rust-owned bit-exact later, ADR-0046);
//   3. upsertKcTypedState — advance the typed-ledger cell, probe-resolution write ONLY,
//      FLIP-inert (written FIRST so the anchor in step 4 implies the ledger advanced);
//   4. append an `experimental:prediction_score` event LAST — LOG ONLY, keyed on the
//      probe_result id (the idempotency anchor); it NEVER moves a label/number.
//
// THREE FLIP-INERT RED-LINES (the whole point — defer-flip-not-build):
//   - scorePrediction LOGS; the claim-survival FLIP (score → flip `mastered`/label) is
//     Rust-owned + DEFERRED (ADR-0046). This loop never moves a label.
//   - Phase 0 supplies NO `confused_with` KC (the conjecture names none) → the §修正-4
//     gate keeps every cell SOFT (`no-evidence`/`open`). `mastered` is structurally
//     unreachable here (upsertKcTypedState never produces it).
//   - retrievability R(t) is recorded in the prediction_score EVENT (fold-replay needs
//     it logged), NEVER in the written kc_typed_state (it has no R column).
//   - this loop NEVER writes FSRS (ND-5): no attempt event, no material_fsrs_state.
//
// Escape-hatch (mirrors probe-lifecycle): `experimental:prediction_score` is NOT in
// RESERVED_EXPERIMENTAL_ACTIONS → it validates via the loose generic ExperimentalEvent
// with zero schema-file change. Do NOT reserve it.

import { z } from 'zod';

import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { scorePrediction } from '@/server/conjectures/scoring';
import { type UpsertKcTypedStateInput, upsertKcTypedState } from '@/server/conjectures/typed-state';
import { getEventById, writeEvent } from '@/server/events/queries';
import type { WriteEventInput } from '@/server/events/queries';
import { and, eq, sql } from 'drizzle-orm';

/** Canonical LOG-only score event — loose escape hatch, NEVER reserved. */
export const PREDICTION_SCORE_ACTION = 'experimental:prediction_score' as const;
/** The U3 producer's outcome event we consume. */
const PROBE_RESULT_ACTION = 'experimental:probe_result' as const;
/** actor_ref stamped on each prediction_score event (same job as the propose half). */
const RECONCILE_ACTOR = 'research_meeting' as const;

/**
 * Deterministic id for the prediction_score anchor = `prediction_score:<probe_result_event_id>`.
 * Bound to the probe (not a fresh newId) so two overlapping reconcile runs that both read the
 * same unscored probe (the NOT EXISTS filter only guards the LIST stage, not the write) can
 * never both insert a score event: writeEvent's onConflictDoNothing(event.id) makes the second
 * a no-op = exactly-once per probe, independent of run concurrency.
 */
function predictionScoreEventId(probeResultEventId: string): string {
  return `prediction_score:${probeResultEventId}`;
}

/** One unanswered-but-now-resolved probe outcome to score (reader output). */
export interface UnscoredProbeResult {
  probe_result_event_id: string;
  /** = the conjecture proposal event id (probe_result payload.conjecture_event_id). */
  conjecture_event_id: string;
  outcome: 0 | 1;
  resolution: 'confirmed' | 'retired';
  /** R(t) snapshot at judge time, or null. Logged in the score event; never written to state. */
  retrievability_at_judge: number | null;
  /** the probe judging time = the new evidence's timestamp (→ last_evidence_at). */
  created_at: Date;
}

// The reconcile loop issues kc_typed_state writes typed DIRECTLY against the real
// UpsertKcTypedStateInput (imported above) — no local re-declaration — so the call site stays
// compile-time-linked to the writer's contract as it evolves. The FLIP-inert red-line
// (`confused_with_kc_id: null` → soft cell, never `mastered`, no R(t) into written state) is
// enforced by the values reconcile supplies + the runtime test assertions, not by the type shape.

export interface ReconcileResult {
  /** probe outcomes scored + ledger-updated this run. */
  reconciled: number;
  /** probe outcomes skipped (dangling / malformed / non-conjecture ref). */
  skipped: number;
}

export interface ReconcileDeps {
  now?: () => Date;
  /** unscored probe outcomes (idempotency lives HERE — already-scored probes excluded). */
  listUnscoredProbeResultsFn?: (db: Db) => Promise<UnscoredProbeResult[]>;
  /** load the conjecture proposal event (writeAiProposal shape: payload.ai_proposal). */
  getEventByIdFn?: (db: Db, id: string) => Promise<{ payload: unknown } | null>;
  writeEventFn?: (db: Db, input: WriteEventInput) => Promise<string>;
  upsertKcTypedStateFn?: (db: Db, input: UpsertKcTypedStateInput) => Promise<void>;
}

/**
 * Targeted parse-barrier on the 5 conjecture facts the loop needs. A small local
 * schema (NOT the whole proposal payload) is the tighter dependency boundary AND
 * fail-closed: a malformed / out-of-range field drops the probe to `skipped` rather
 * than poisoning a score. recurrence_count mirrors the conjecture floor (>= 2).
 */
const ConjectureFactsSchema = z.object({
  knowledge_id: z.string().min(1),
  predicted_p: z.number().min(0).max(1),
  baseline_p_at_induction: z.number().min(0).max(1),
  discriminating: z.boolean(),
  recurrence_count: z.number().int().min(2),
});
type ConjectureFacts = z.infer<typeof ConjectureFactsSchema>;

/** Extract + validate the conjecture facts, or null (skip) for any unsound event. */
function extractConjectureFacts(ev: { payload: unknown } | null): ConjectureFacts | null {
  if (!ev) return null;
  const aiProposal = (
    ev.payload as { ai_proposal?: { kind?: unknown; proposed_change?: unknown } } | null
  )?.ai_proposal;
  if (!aiProposal || aiProposal.kind !== 'conjecture') return null;
  const parsed = ConjectureFactsSchema.safeParse(aiProposal.proposed_change);
  return parsed.success ? parsed.data : null;
}

/**
 * Real reader: unanswered probe outcomes that have NO prediction_score yet. The
 * NOT EXISTS on a prediction_score whose subject_id == the probe_result event id is
 * the idempotency filter — a re-run scores nothing already scored (append-only,
 * never a duplicate). Parse-barrier on the probe_result payload (conjecture ref /
 * outcome / resolution must be sound) drops anomalies silently.
 *
 * Deliberately UNBOUNDED (no LIMIT): a batch cap + FIFO order would let a head of
 * permanently-unscorable probes (dangling / malformed conjecture, which are `continue`d
 * without writing a terminal marker) starve newer valid probes forever. The unscored set is
 * naturally tiny for the n=1 nightly load — bounded by the ≤3 concurrent-probe cap +
 * owner-paced answering + nightly cadence, each probe ≈ 3 cheap DB ops — so processing all of
 * it keeps the reconcile (which precedes the propose half) from blocking on a starved head. A
 * terminal skip-marker + LIMIT would be the scale-time answer if this ever outgrows n=1.
 */
async function defaultListUnscoredProbeResults(db: Db): Promise<UnscoredProbeResult[]> {
  const rows = await db
    .select({ id: event.id, payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        sql`NOT EXISTS (
          SELECT 1 FROM ${event} ps
          WHERE ps.action = ${PREDICTION_SCORE_ACTION}
            AND ps.subject_kind = 'event'
            AND ps.subject_id = ${event.id}
        )`,
      ),
    )
    .orderBy(event.created_at);

  const out: UnscoredProbeResult[] = [];
  for (const r of rows) {
    const p = r.payload as {
      conjecture_event_id?: unknown;
      outcome?: unknown;
      resolution?: unknown;
      retrievability_at_judge?: unknown;
    } | null;
    const conjectureEventId = p?.conjecture_event_id;
    const outcome = p?.outcome;
    const resolution = p?.resolution;
    // Reader-level drops are logged (not just silently `continue`d) so a systemic malformed-
    // payload bug surfaces in the job log, mirroring the loop-body skip warns.
    if (typeof conjectureEventId !== 'string' || conjectureEventId.length === 0) {
      console.warn('[reconcile] dropping malformed probe_result — bad conjecture_event_id', r.id);
      continue;
    }
    if (outcome !== 0 && outcome !== 1) {
      console.warn('[reconcile] dropping malformed probe_result — invalid outcome', r.id);
      continue;
    }
    if (resolution !== 'confirmed' && resolution !== 'retired') {
      console.warn('[reconcile] dropping malformed probe_result — invalid resolution', r.id);
      continue;
    }
    const rt = p?.retrievability_at_judge;
    out.push({
      probe_result_event_id: r.id,
      conjecture_event_id: conjectureEventId,
      outcome,
      resolution,
      // R(t) is a probability in [0,1]; coerce NaN / ±Infinity / out-of-range to null so a
      // malformed value can't poison the LOG event (fail-closed, like the fields above).
      retrievability_at_judge:
        typeof rt === 'number' && Number.isFinite(rt) && rt >= 0 && rt <= 1 ? rt : null,
      created_at: r.created_at,
    });
  }
  return out;
}

/**
 * Score each unscored probe outcome against its conjecture's prediction, advance the
 * typed-ledger cell, then append a LOG-only prediction_score event LAST as the idempotency
 * ANCHOR (so "scored ⟹ ledgered" — a partial failure re-processes next run, never drops
 * the ledger advance). Idempotent (the reader excludes already-scored probes), append-only,
 * FLIP-inert. A dangling / malformed / non-conjecture / unreadable conjecture ref is SKIPPED
 * (counted), never thrown — a single bad row must not abort the nightly run (which also
 * gates the propose half). Write faults DO propagate so pg-boss retries (self-healing).
 */
export async function reconcileConjecturePredictions(
  db: Db,
  deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  const now = deps.now?.() ?? new Date();
  const listUnscored = deps.listUnscoredProbeResultsFn ?? defaultListUnscoredProbeResults;
  const getEventByIdFn = deps.getEventByIdFn ?? getEventById;
  const writeEventFn = deps.writeEventFn ?? writeEvent;
  const upsertFn = deps.upsertKcTypedStateFn ?? upsertKcTypedState;

  const unscored = await listUnscored(db);
  let reconciled = 0;
  let skipped = 0;

  for (const pr of unscored) {
    // The READ is the only fail-soft step. The default getEventById runs the row through
    // parseEvent, which THROWS on a corrupt / unparseable conjecture row (schema drift,
    // manual DB edit). Catch ONLY the read → counted skip, so one bad row can't abort the
    // nightly run (which also gates the propose half). The WRITES below are intentionally
    // NOT caught: a write fault must propagate so pg-boss retries, and the
    // upsert-before-anchor order (see below) makes that retry self-healing.
    let conjEvent: { payload: unknown } | null;
    try {
      conjEvent = await getEventByIdFn(db, pr.conjecture_event_id);
    } catch (err) {
      console.warn(
        '[reconcile] skipping probe_result — conjecture ref unreadable',
        pr.probe_result_event_id,
        pr.conjecture_event_id,
        err,
      );
      skipped += 1;
      continue;
    }
    const facts = extractConjectureFacts(conjEvent);
    if (!facts) {
      // Dangling / malformed / non-conjecture ref — a data anomaly, not a job failure.
      console.warn(
        '[reconcile] skipping probe_result with no sound conjecture',
        pr.probe_result_event_id,
        pr.conjecture_event_id,
      );
      skipped += 1;
      continue;
    }

    const score = scorePrediction(facts.predicted_p, facts.baseline_p_at_induction, pr.outcome);

    // ORDER IS LOAD-BEARING (idempotency / no silent ledger loss). Advance the typed-ledger
    // cell FIRST, then write the prediction_score event LAST as the idempotency ANCHOR. The
    // reader excludes a probe IFF its prediction_score exists, so the invariant
    // "score event exists ⟹ ledger already advanced" holds: a crash/throw between the two
    // writes leaves the probe unscored and it is safely re-processed next run — the upsert is
    // idempotent (set-union evidence_event_ids + GREATEST last_evidence_at + deterministic
    // nextTypedState), so the re-run is a no-op. Writing the anchor FIRST would permanently
    // drop the ledger advance on a partial failure.
    //
    // (1) typed-ledger cell — probe-resolution write ONLY, FLIP-inert. Phase 0 names no
    // confused_with KC → §修正-4 gate keeps it soft (no-evidence/open). `mastered` is
    // structurally unreachable; no FSRS (ND-5); no R(t) into written state.
    await upsertFn(db, {
      subject_id: facts.knowledge_id,
      subject_kind: 'knowledge',
      proposed: pr.resolution === 'confirmed' ? 'confused-with-X' : 'no-evidence',
      confused_with_kc_id: null,
      discriminating: facts.discriminating,
      recurrence_count: facts.recurrence_count,
      evidence_event_ids: [pr.conjecture_event_id, pr.probe_result_event_id],
      last_evidence_at: pr.created_at,
    });

    // (2) LOG the comparison + SET the idempotency anchor (written LAST) — append-only,
    // keyed on the probe_result id, envelope outcome OMITTED (NOT an attempt; ND-5).
    await writeEventFn(db, {
      // Deterministic anchor id (NOT newId) — exactly-once per probe even under concurrent
      // reconcile runs, via writeEvent's onConflictDoNothing(event.id). See helper docblock.
      id: predictionScoreEventId(pr.probe_result_event_id),
      actor_kind: 'system',
      actor_ref: RECONCILE_ACTOR,
      action: PREDICTION_SCORE_ACTION,
      subject_kind: 'event',
      subject_id: pr.probe_result_event_id,
      payload: {
        conjecture_event_id: pr.conjecture_event_id,
        probe_result_event_id: pr.probe_result_event_id,
        knowledge_id: facts.knowledge_id,
        predicted_p: facts.predicted_p,
        baseline_p: facts.baseline_p_at_induction,
        outcome: pr.outcome,
        resolution: pr.resolution,
        brier_model: score.brierModel,
        brier_baseline: score.brierBaseline,
        log_loss_model: score.logLossModel,
        skill_score_point: score.skillScorePoint,
        // R(t) recorded HERE only — fold-replay needs it logged, the typed-state has no R.
        retrievability_at_judge: pr.retrievability_at_judge,
      },
      caused_by_event_id: pr.probe_result_event_id,
      created_at: now,
      // Opt OUT of the memory-ingestion outbox (ADR-0021): a system-derived LOG-only scoring
      // event is NOT user activity and must not become a Mem0 memory. A non-NULL ingest_at
      // stamp opts the row out of the `WHERE ingest_at IS NULL` poller — mirrors the
      // state_snapshot / genesis / artifact-lifecycle system events.
      ingest_at: now,
    });
    reconciled += 1;
  }

  return { reconciled, skipped };
}
