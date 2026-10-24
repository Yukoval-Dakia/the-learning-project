// Read-only admin reader for conjecture calibration.
//
// Prediction scores are live single-point proper scores per probe, never accuracy or a
// window mean. Confused-with-X typed states are pending energization: the only caller
// hardcodes a null second KC while the gate requires a named one, so keep the query and
// present the panel as pending rather than auto-minted or impossible.
//
// score_basis='single_point' keeps consumers from reading it as window-calibrated.

import { and, desc, eq } from 'drizzle-orm';
import { getEffectiveProbeResultStatuses } from '@/capabilities/agency/public';
import { type ProbeResolution, isProbeResolution } from '@/core/schema/conjecture';
import type { Db, Tx } from '@/db/client';
import { event, kc_typed_state } from '@/db/schema';

/** One mapped prediction_score row. */
export interface ConjecturePredictionScoreRow {
  event_id: string;
  conjecture_event_id: string;
  probe_result_event_id: string;
  knowledge_id: string;
  predicted_p: number;
  baseline_p: number;
  outcome: 0 | 1;
  resolution: ProbeResolution;
  brier_model: number | null;
  brier_baseline: number | null;
  log_loss_model: number | null;
  skill_score_point: number | null;
  retrievability_at_judge: number | null;
  created_at: string;
}

/** Contract for the not-yet-produced confused-with-X row. */
export interface ConjectureTypedStateRow {
  id: string;
  knowledge_id: string;
  typed_state: 'confused-with-X';
  confused_with_kc_id: string;
  lifecycle: 'open' | 'resolved';
  evidence_event_ids: string[];
  last_evidence_at: string | null;
  updated_at: string;
}

export interface ConjectureScoresRead {
  /** Single-point proper score, not a window mean. */
  score_basis: 'single_point';
  prediction_scores: ConjecturePredictionScoreRow[];
  typed_states: ConjectureTypedStateRow[];
  diagnostics: {
    prediction_scores: ConjectureScanDiagnostics;
    typed_states: ConjectureScanDiagnostics;
  };
}

export interface ConjectureScanDiagnostics {
  scanned_count: number;
  /** Malformed rows plus scores whose source probe was corrected or inactive. */
  dropped_count: number;
  /** Older matching rows exist beyond the scan bound. */
  scan_truncated: boolean;
}

const PREDICTION_SCORE_ACTION = 'experimental:prediction_score';
const ADMIN_RESULT_LIMIT = 200;
// Bounded over-fetch so a small corrupt tail does not crowd out valid rows.
const ADMIN_SCAN_LIMIT = ADMIN_RESULT_LIMIT * 2;

type OptionalNumber = { ok: true; value: number | null } | { ok: false };

function optionalFiniteNumber(value: unknown): OptionalNumber {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function extractProbeResultEventId(row: typeof event.$inferSelect): string | undefined {
  const id = (row.payload as Record<string, unknown> | null)?.probe_result_event_id;
  return typeof id === 'string' ? id : undefined;
}

function rowToScore(r: typeof event.$inferSelect): ConjecturePredictionScoreRow | null {
  const p = r.payload as Record<string, unknown> | null;
  if (!p) return null;
  // Fail closed per field; never render a partially valid score.
  const predicted_p = p.predicted_p;
  const baseline_p = p.baseline_p;
  const outcome = p.outcome;
  const resolution = p.resolution;
  if (typeof predicted_p !== 'number' || !Number.isFinite(predicted_p)) return null;
  if (typeof baseline_p !== 'number' || !Number.isFinite(baseline_p)) return null;
  if (outcome !== 0 && outcome !== 1) return null;
  if (!isProbeResolution(resolution)) return null;
  const conj = p.conjecture_event_id;
  const probe = p.probe_result_event_id;
  const kc = p.knowledge_id;
  if (!isNonEmptyString(conj) || !isNonEmptyString(probe) || !isNonEmptyString(kc)) return null;
  if (!isValidDate(r.created_at)) return null;
  const brierModel = optionalFiniteNumber(p.brier_model);
  const brierBaseline = optionalFiniteNumber(p.brier_baseline);
  const logLossModel = optionalFiniteNumber(p.log_loss_model);
  const skillScorePoint = optionalFiniteNumber(p.skill_score_point);
  const retrievability = optionalFiniteNumber(p.retrievability_at_judge);
  if (
    !brierModel.ok ||
    !brierBaseline.ok ||
    !logLossModel.ok ||
    !skillScorePoint.ok ||
    !retrievability.ok
  ) {
    return null;
  }
  return {
    event_id: r.id,
    conjecture_event_id: conj,
    probe_result_event_id: probe,
    knowledge_id: kc,
    predicted_p,
    baseline_p,
    outcome,
    resolution,
    brier_model: brierModel.value,
    brier_baseline: brierBaseline.value,
    log_loss_model: logLossModel.value,
    skill_score_point: skillScorePoint.value,
    retrievability_at_judge: retrievability.value,
    created_at: r.created_at.toISOString(),
  };
}

function rowToTypedState(r: typeof kc_typed_state.$inferSelect): ConjectureTypedStateRow | null {
  if (!isNonEmptyString(r.id) || r.subject_kind !== 'knowledge') return null;
  if (!isNonEmptyString(r.subject_id) || r.typed_state !== 'confused-with-X') return null;
  if (!isNonEmptyString(r.confused_with_kc_id)) return null;
  if (r.lifecycle !== 'open' && r.lifecycle !== 'resolved') return null;
  if (!Array.isArray(r.evidence_event_ids) || !r.evidence_event_ids.every(isNonEmptyString)) {
    return null;
  }
  if (r.last_evidence_at !== null && !isValidDate(r.last_evidence_at)) return null;
  if (!isValidDate(r.updated_at)) return null;
  return {
    id: r.id,
    knowledge_id: r.subject_id,
    typed_state: r.typed_state,
    confused_with_kc_id: r.confused_with_kc_id,
    lifecycle: r.lifecycle,
    evidence_event_ids: r.evidence_event_ids,
    last_evidence_at: r.last_evidence_at?.toISOString() ?? null,
    updated_at: r.updated_at.toISOString(),
  };
}

function collectBoundedRows<Raw, Mapped>(
  rowsWithSentinel: readonly Raw[],
  map: (row: Raw) => Mapped | null,
): { rows: Mapped[]; diagnostics: ConjectureScanDiagnostics } {
  // One sentinel past the window distinguishes exactly N from a truncated backlog.
  const scanWindow = rowsWithSentinel.slice(0, ADMIN_SCAN_LIMIT);
  const rows: Mapped[] = [];
  let scanned_count = 0;
  let dropped_count = 0;
  for (const raw of scanWindow) {
    scanned_count += 1;
    const mapped = map(raw);
    if (mapped === null) dropped_count += 1;
    else rows.push(mapped);
    if (rows.length === ADMIN_RESULT_LIMIT) break;
  }
  return {
    rows,
    diagnostics: {
      scanned_count,
      dropped_count,
      scan_truncated:
        rowsWithSentinel.length > ADMIN_SCAN_LIMIT || scanned_count < scanWindow.length,
    },
  };
}

/**
 * Two read-only queries: live prediction scores and the still-empty confused-with-X
 * rows. Never writes, flips flags, or touches scheduling or mastery.
 */
export async function loadConjectureScores(db: Db | Tx): Promise<ConjectureScoresRead> {
  const scoreRows = await db
    .select()
    .from(event)
    .where(eq(event.action, PREDICTION_SCORE_ACTION))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(ADMIN_SCAN_LIMIT + 1);
  const scoreStatuses = await getEffectiveProbeResultStatuses(
    db,
    scoreRows.flatMap((row) => {
      const probeResultEventId = extractProbeResultEventId(row);
      return typeof probeResultEventId === 'string' ? [probeResultEventId] : [];
    }),
  );
  const scores = collectBoundedRows(scoreRows, (row) => {
    const probeResultEventId = extractProbeResultEventId(row);
    const sourceStatus =
      typeof probeResultEventId === 'string' ? scoreStatuses.get(probeResultEventId) : undefined;
    if (
      typeof probeResultEventId !== 'string' ||
      sourceStatus === 'corrected' ||
      sourceStatus === 'dependency_inactive'
    ) {
      return null;
    }
    return rowToScore(row);
  });
  const typedRows = await db
    .select()
    .from(kc_typed_state)
    .where(
      and(
        eq(kc_typed_state.subject_kind, 'knowledge'),
        eq(kc_typed_state.typed_state, 'confused-with-X'),
      ),
    )
    .orderBy(desc(kc_typed_state.updated_at), desc(kc_typed_state.id))
    .limit(ADMIN_SCAN_LIMIT + 1);
  const typed = collectBoundedRows(typedRows, rowToTypedState);

  return {
    score_basis: 'single_point',
    prediction_scores: scores.rows,
    typed_states: typed.rows,
    diagnostics: {
      prediction_scores: scores.diagnostics,
      typed_states: typed.diagnostics,
    },
  };
}
