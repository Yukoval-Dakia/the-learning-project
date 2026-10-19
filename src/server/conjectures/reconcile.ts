// Turns a probe outcome into a prediction score and a typed-state cell.
// Without it, probe outcomes accumulate and the typed ledger never moves.
// Joins the probe to its conjecture by conjecture_event_id. Does not guess by KC and time window.
// Writes the typed-state cell first, then a deterministic anchor, so an anchor means the cell already advanced.
// Sequence 1 anchors a prediction score. Sequence 2 anchors a score-free projection.
// The conjecture's predicted probability is calibrated for the first probe only.
// Accountability may reorder conjecture candidates. It does not flip mastery, typed state, or FSRS.
// This loop passes a null confused-with KC, so the typed-state gate keeps every cell soft.
// Do not clear that null from here. Naming the other KC belongs on induction, and the column has no foreign key.
// This is the only production caller of upsertKcTypedState, so nothing currently writes confused-with-X.
// An empty admin column is that fact, not missing learner data. `mastered` is unreachable here.
// Retrievability is stored on the anchor event because replay needs it. kc_typed_state has no such column.
// Does not write FSRS.
// Neither anchor action is reserved. Both stay on the loose experimental event. Do not reserve them here.

import { ZodError, z } from 'zod';
import { getEffectiveProbeResultStatuses } from '@/capabilities/agency/public';
import {
  PREDICTION_SCORE_ACTION,
  PROBE_NON_EVIDENCE_RESOLUTION,
  PROBE_RESULT_PROJECTED_ACTION,
  type ProbeResolution,
  isCanonicalEvidenceProbeOutcomeResolution,
} from '@/core/schema/conjecture';
import { type WriteEventInput, getEventById, writeEvent } from '@/kernel/events';

export {
  PREDICTION_SCORE_ACTION,
  PROBE_RESULT_PROJECTED_ACTION,
} from '@/core/schema/conjecture';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { scorePrediction } from '@/server/conjectures/scoring';
import {
  type ReplaceKcTypedStateInput,
  type UpsertKcTypedStateInput,
  replaceKcTypedState,
  upsertKcTypedState,
} from '@/server/conjectures/typed-state';

/** The producer event this loop consumes. */
const PROBE_RESULT_ACTION = 'experimental:probe_result' as const;
/** Same actor as the propose half, so a derived anchor is not mistaken for a learner action. */
const RECONCILE_ACTOR = 'research_meeting' as const;

/**
 * Stable id `prediction_score:<probe result>`.
 * The list query's NOT EXISTS check does not cover the write. Two overlapping runs can both
 * see the same probe. A fresh id would insert two scores. Conflict on this id makes the second a no-op.
 */
function predictionScoreEventId(probeResultEventId: string): string {
  return `prediction_score:${probeResultEventId}`;
}

/** Stable id for a sequence-2 projection, which has no score of its own. */
function probeResultProjectedEventId(probeResultEventId: string): string {
  return `probe_result_projected:${probeResultEventId}`;
}

/** One probe outcome that has no anchor yet. Sequence 2 is projected and not scored. */
export interface UnscoredProbeResult {
  probe_result_event_id: string;
  probe_question_id: string;
  conjecture_event_id: string;
  outcome: 0 | 1;
  resolution: ProbeResolution;
  /** Logged on the anchor event only. Typed state has no column for it. */
  retrievability_at_judge: number | null;
  /** Probe time, not the nightly batch time. Becomes last_evidence_at. */
  created_at: Date;
  /** False for sequence 2. That probe has no probability of its own. */
  prediction_score_eligible?: boolean;
  /**
   * A terminal sequence-2 result names both independent questions.
   * Readers confirm the sequence-1 score from this list instead of inventing a second prediction.
   */
  independent_probe_question_ids?: string[];
}

// No local copy of the upsert input. A drift in the writer stays a compile error here.
// The soft cell comes from the null confused-with value this loop passes, not from the type.

export interface ReconcileResult {
  /** Probe outcomes that received an anchor this run. */
  reconciled: number;
  /** Dangling, malformed, or non-conjecture refs. A bad row does not abort the run. */
  skipped: number;
}

export interface ReconcileDeps {
  now?: () => Date;
  /** Stamped on anchors so a retry can recover the nightly aggregate without a second score. */
  executionId?: string;
  /** Already-anchored probes stay out. That exclusion is what makes a rerun idempotent. */
  listUnscoredProbeResultsFn?: (db: Db) => Promise<UnscoredProbeResult[]>;
  getEventByIdFn?: (db: Db, id: string) => Promise<{ payload: unknown } | null>;
  /** Rebuild cells whose source evidence was corrected after the anchor was written. */
  repairCorrectedProjectionsFn?: (db: Db) => Promise<void>;
  writeEventFn?: (db: Db, input: WriteEventInput) => Promise<string>;
  upsertKcTypedStateFn?: (db: Db, input: UpsertKcTypedStateInput) => Promise<void>;
}

/**
 * Only the five facts this loop scores on. A bad field skips the probe instead of poisoning a score.
 * recurrence_count stays at the conjecture floor of 2, so a one-off probe cannot enter.
 */
const ConjectureFactsSchema = z.object({
  knowledge_id: z.string().min(1),
  predicted_p: z.number().min(0).max(1),
  baseline_p_at_induction: z.number().min(0).max(1),
  discriminating: z.boolean(),
  recurrence_count: z.number().int().min(2),
});
type ConjectureFacts = z.infer<typeof ConjectureFactsSchema>;

/** Null skips the probe. An unsound proposal must not become a score. */
function extractConjectureFacts(ev: { payload: unknown } | null): ConjectureFacts | null {
  if (!ev) return null;
  const aiProposal = (
    ev.payload as { ai_proposal?: { kind?: unknown; proposed_change?: unknown } } | null
  )?.ai_proposal;
  if (!aiProposal || aiProposal.kind !== 'conjecture') return null;
  const parsed = ConjectureFactsSchema.safeParse(aiProposal.proposed_change);
  return parsed.success ? parsed.data : null;
}

interface ProjectionAnchor {
  probeResultEventId: string;
  conjectureEventId: string;
}

function projectionAnchor(row: { subject_id: string; payload: unknown }): ProjectionAnchor | null {
  const payload = row.payload as Record<string, unknown> | null;
  const probeResultEventId = payload?.probe_result_event_id;
  const conjectureEventId = payload?.conjecture_event_id;
  if (
    typeof probeResultEventId !== 'string' ||
    probeResultEventId !== row.subject_id ||
    typeof conjectureEventId !== 'string' ||
    conjectureEventId.length === 0
  ) {
    return null;
  }
  return { probeResultEventId, conjectureEventId };
}

async function rebuildTypedStateForKnowledge(db: Db, knowledgeId: string): Promise<void> {
  // These reads run before the per-KC lock inside replaceKcTypedState.
  // Safe while reconciliation is a single pg-boss instance. A second instance could
  // anchor a probe between this snapshot and the replace. Move the reads under that lock first.
  const anchorRows = await db
    .select({ subject_id: event.subject_id, payload: event.payload })
    .from(event)
    .where(
      and(
        inArray(event.action, [PREDICTION_SCORE_ACTION, PROBE_RESULT_PROJECTED_ACTION]),
        sql`${event.payload}->>'knowledge_id' = ${knowledgeId}`,
      ),
    );
  const anchors = anchorRows.flatMap((row) => {
    const parsed = projectionAnchor(row);
    return parsed ? [parsed] : [];
  });
  const statuses = await getEffectiveProbeResultStatuses(
    db,
    anchors.map((anchor) => anchor.probeResultEventId),
  );
  const activeAnchors = anchors.filter(
    (anchor) => statuses.get(anchor.probeResultEventId) === 'active',
  );
  if (activeAnchors.length === 0) {
    await replaceKcTypedState(db, knowledgeId, null);
    return;
  }

  const resultRows = await db
    .select({ id: event.id, payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        inArray(
          event.id,
          activeAnchors.map((anchor) => anchor.probeResultEventId),
        ),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id));
  const conjectureIds = [...new Set(activeAnchors.map((anchor) => anchor.conjectureEventId))];
  const conjectureRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(inArray(event.id, conjectureIds));
  const factsByConjecture = new Map(
    conjectureRows.flatMap((row) => {
      const facts = extractConjectureFacts(row);
      return facts?.knowledge_id === knowledgeId ? [[row.id, facts] as const] : [];
    }),
  );
  const anchorByResult = new Map(
    activeAnchors.map((anchor) => [anchor.probeResultEventId, anchor] as const),
  );
  const replayRows = resultRows.flatMap((row) => {
    const anchor = anchorByResult.get(row.id);
    const payload = row.payload as Record<string, unknown> | null;
    const resolution = payload?.resolution;
    const outcome = payload?.outcome;
    const disposition = { outcome, resolution };
    if (
      !anchor ||
      payload?.conjecture_event_id !== anchor.conjectureEventId ||
      !isCanonicalEvidenceProbeOutcomeResolution(disposition)
    ) {
      return [];
    }
    const facts = factsByConjecture.get(anchor.conjectureEventId);
    return facts ? [{ row, anchor, resolution: disposition.resolution, facts }] : [];
  });
  const latest = replayRows.at(-1);
  if (!latest) {
    await replaceKcTypedState(db, knowledgeId, null);
    return;
  }
  const replacement: ReplaceKcTypedStateInput = {
    proposed: latest.resolution === 'confirmed' ? 'confused-with-X' : 'no-evidence',
    confused_with_kc_id: null,
    discriminating: latest.facts.discriminating,
    recurrence_count: latest.facts.recurrence_count,
    evidence_event_ids: [
      ...new Set(
        replayRows.flatMap(({ anchor }) => [anchor.conjectureEventId, anchor.probeResultEventId]),
      ),
    ],
    last_evidence_at: latest.row.created_at,
  };
  await replaceKcTypedState(db, knowledgeId, replacement);
}

async function defaultRepairCorrectedProjections(db: Db): Promise<void> {
  const correctedResultIds = db
    .select({ id: event.subject_id })
    .from(event)
    .where(and(eq(event.action, 'correct'), eq(event.subject_kind, 'event')));
  const affectedAnchors = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        inArray(event.action, [PREDICTION_SCORE_ACTION, PROBE_RESULT_PROJECTED_ACTION]),
        inArray(event.subject_id, correctedResultIds),
      ),
    );
  const knowledgeIds = [
    ...new Set(
      affectedAnchors.flatMap((row) => {
        const knowledgeId = (row.payload as Record<string, unknown> | null)?.knowledge_id;
        return typeof knowledgeId === 'string' && knowledgeId.length > 0 ? [knowledgeId] : [];
      }),
    ),
  ];
  for (const knowledgeId of knowledgeIds) {
    await rebuildTypedStateForKnowledge(db, knowledgeId);
  }
}

/**
 * Probe outcomes with neither a prediction score nor a score-free projection anchor.
 * The missing-anchor filter is what makes a rerun append instead of duplicate.
 *
 * Sequence 2 stays in the list and is not scored. Its predicted probability was calibrated
 * for the first probe. Reusing it would invent a score the model never made.
 *
 * No LIMIT. Unscorable probes are skipped without a terminal marker, so a capped FIFO queue
 * would let that head block newer valid probes forever. The set stays small under one learner,
 * the concurrent-probe cap, and a nightly cadence. A skip marker plus a limit belongs here
 * only if that assumption breaks.
 */
async function defaultListUnscoredProbeResults(db: Db): Promise<UnscoredProbeResult[]> {
  const rows = await db
    .select({
      id: event.id,
      probe_question_id: event.subject_id,
      payload: event.payload,
      created_at: event.created_at,
      probe_metadata: question.metadata,
    })
    .from(event)
    .leftJoin(question, eq(question.id, event.subject_id))
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        // An ordinary wrong answer is terminal and has no 0 or 1 prediction outcome.
        // Leave it out, or every nightly run logs it again as malformed.
        sql`${event.payload}->>'resolution' IS DISTINCT FROM ${PROBE_NON_EVIDENCE_RESOLUTION}`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${event} anchor
          WHERE anchor.action IN (${PREDICTION_SCORE_ACTION}, ${PROBE_RESULT_PROJECTED_ACTION})
            AND anchor.subject_kind = 'event'
            AND anchor.subject_id = ${event.id}
        )`,
      ),
    )
    .orderBy(event.created_at);

  const out: UnscoredProbeResult[] = [];
  const evidenceStatuses = await getEffectiveProbeResultStatuses(
    db,
    rows.map((row) => row.id),
  );
  for (const r of rows) {
    // A confirmation counts only while both independent results are still active.
    // Fold that before the first anchor, or a corrected preliminary result leaves a bad projection.
    if (evidenceStatuses.get(r.id) !== 'active') continue;
    const p = r.payload as {
      conjecture_event_id?: unknown;
      outcome?: unknown;
      resolution?: unknown;
      retrievability_at_judge?: unknown;
      independent_probe_question_ids?: unknown;
    } | null;
    const conjectureEventId = p?.conjecture_event_id;
    const outcome = p?.outcome;
    const resolution = p?.resolution;
    const disposition = { outcome, resolution };
    // Log the drop. A silent continue hides a payload that fails the same way every night.
    if (typeof conjectureEventId !== 'string' || conjectureEventId.length === 0) {
      console.warn('[reconcile] dropping malformed probe_result — bad conjecture_event_id', r.id);
      continue;
    }
    if (!isCanonicalEvidenceProbeOutcomeResolution(disposition)) {
      console.warn(
        '[reconcile] dropping malformed probe_result — outcome/resolution mismatch',
        r.id,
      );
      continue;
    }
    const rt = p?.retrievability_at_judge;
    const independentProbeQuestionIds = Array.isArray(p?.independent_probe_question_ids)
      ? [
          ...new Set(
            p.independent_probe_question_ids.filter(
              (id): id is string => typeof id === 'string' && id.length > 0,
            ),
          ),
        ]
      : [];
    out.push({
      probe_result_event_id: r.id,
      probe_question_id: r.probe_question_id,
      conjecture_event_id: conjectureEventId,
      outcome: disposition.outcome,
      resolution: disposition.resolution,
      // A non-finite or out-of-range probability becomes null so it cannot land on the anchor.
      retrievability_at_judge:
        typeof rt === 'number' && Number.isFinite(rt) && rt >= 0 && rt <= 1 ? rt : null,
      created_at: r.created_at,
      prediction_score_eligible:
        (r.probe_metadata as Record<string, unknown> | null)?.probe_sequence !== 2,
      ...(independentProbeQuestionIds.length > 0
        ? { independent_probe_question_ids: independentProbeQuestionIds }
        : {}),
    });
  }
  return out;
}

/**
 * Project each unanchored probe. Sequence 1 is scored. Sequence 2 is not.
 * The anchor is written last, so a crash retries the ledger write instead of skipping it.
 * A bad conjecture reference is counted and skipped. One bad row must not abort the night,
 * because this run also gates the propose half. Write faults propagate so pg-boss retries.
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
  const repairCorrectedProjections =
    deps.repairCorrectedProjectionsFn ?? defaultRepairCorrectedProjections;

  await repairCorrectedProjections(db);
  const unscored = await listUnscored(db);
  let reconciled = 0;
  let skipped = 0;

  for (const pr of unscored) {
    if (
      !isCanonicalEvidenceProbeOutcomeResolution({
        outcome: pr.outcome,
        resolution: pr.resolution,
      })
    ) {
      console.warn(
        '[reconcile] skipping probe_result — outcome/resolution mismatch',
        pr.probe_result_event_id,
      );
      skipped += 1;
      continue;
    }
    // Only a ZodError is a counted skip. That is a poison row (schema drift or a hand edit).
    // A connection, timeout, or other read failure must propagate. Swallowing it would look like
    // a clean skip and let the propose half run on stale state. Write errors below are also
    // uncaught. The upsert-then-anchor order makes the retry safe.
    let conjEvent: { payload: unknown } | null;
    try {
      conjEvent = await getEventByIdFn(db, pr.conjecture_event_id);
    } catch (err) {
      if (!(err instanceof ZodError)) throw err;
      console.warn(
        '[reconcile] skipping probe_result — conjecture ref unparseable',
        pr.probe_result_event_id,
        pr.conjecture_event_id,
        err,
      );
      skipped += 1;
      continue;
    }
    const facts = extractConjectureFacts(conjEvent);
    if (!facts) {
      // A data anomaly, not a job failure.
      console.warn(
        '[reconcile] skipping probe_result with no sound conjecture',
        pr.probe_result_event_id,
        pr.conjecture_event_id,
      );
      skipped += 1;
      continue;
    }

    const predictionScoreEligible = pr.prediction_score_eligible !== false;
    const score = predictionScoreEligible
      ? scorePrediction(facts.predicted_p, facts.baseline_p_at_induction, pr.outcome)
      : null;

    // Ledger first, anchor last. The reader skips a probe once either anchor exists.
    // A crash between the two leaves the probe unanchored, and the upsert is idempotent, so the
    // retry is a no-op. Writing the anchor first would drop the ledger update on a partial failure.
    // evidence_for stays no-evidence. One observation is not enough to mint confused-with-X,
    // and this loop names no other KC.
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

    // Anchor last. Not an attempt, so the envelope carries no outcome. Sequence 2 logs provenance only.
    await writeEventFn(db, {
      // Not newId. Conflict on this id is the exactly-once guarantee.
      id: predictionScoreEligible
        ? predictionScoreEventId(pr.probe_result_event_id)
        : probeResultProjectedEventId(pr.probe_result_event_id),
      actor_kind: 'system',
      actor_ref: RECONCILE_ACTOR,
      action: predictionScoreEligible ? PREDICTION_SCORE_ACTION : PROBE_RESULT_PROJECTED_ACTION,
      subject_kind: 'event',
      subject_id: pr.probe_result_event_id,
      payload: {
        conjecture_event_id: pr.conjecture_event_id,
        probe_result_event_id: pr.probe_result_event_id,
        probe_question_id: pr.probe_question_id,
        knowledge_id: facts.knowledge_id,
        outcome: pr.outcome,
        resolution: pr.resolution,
        discriminating: facts.discriminating,
        // Do not treat the question id as a context class. Two questions can test the same
        // representation, and that would forge the context-spread gate. The reader falls back
        // to the knowledge id until an explicit class is supplied. Only an explicit target-error
        // judgment may set m_diagnostic.
        ...(pr.independent_probe_question_ids && pr.independent_probe_question_ids.length > 0
          ? { independent_probe_question_ids: pr.independent_probe_question_ids }
          : {}),
        ...(score
          ? {
              predicted_p: facts.predicted_p,
              baseline_p: facts.baseline_p_at_induction,
              brier_model: score.brierModel,
              brier_baseline: score.brierBaseline,
              log_loss_model: score.logLossModel,
              skill_score_point: score.skillScorePoint,
            }
          : { projection_kind: 'recurrence_without_prediction' }),
        // Anchor only. Typed state has no retrievability column.
        retrievability_at_judge: pr.retrievability_at_judge,
        ...(deps.executionId ? { research_meeting_execution_id: deps.executionId } : {}),
      },
      caused_by_event_id: pr.probe_result_event_id,
      // Keep the probe's own time. Stamping every anchor with the batch clock would
      // let id order invert a hit/miss streak.
      created_at: pr.created_at,
      // A non-null ingest_at opts this row out of the memory poller (ADR-0021).
      // A derived score is not user activity and must not become a memory.
      ingest_at: now,
    });
    reconciled += 1;
  }

  return { reconciled, skipped };
}
