// Read-only calibration maturity per KC: how far theta uncertainty has tightened from
// the cold-start prior. Diagnostic axis only; it does not touch FSRS scheduling.
//
// Data comes from mastery_state (precision is converted to a standard error on read,
// evidence count), item_calibration aggregated through question knowledge ids, and a
// knowledge left join so never-attempted KCs still count as cold start.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { thetaSe } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { item_calibration, knowledge, mastery_state, question } from '@/db/schema';

type DbLike = Db | Tx;

// Firm means both enough evidence (matching theta's cold-start length) and precision
// above the weak-prior default, so uncertainty has actually tightened. Either alone can
// misjudge; never attempted is always cold start.
export const COLD_START_EVIDENCE_FLOOR = 4;
export const COLD_START_PRECISION_CEILING = 1.0;

function isColdStart(evidenceCount: number, thetaPrecision: number, hasState: boolean): boolean {
  if (!hasState) return true;
  return (
    evidenceCount < COLD_START_EVIDENCE_FLOOR || thetaPrecision <= COLD_START_PRECISION_CEILING
  );
}

export interface CalibrationMaturityRow {
  knowledge_id: string;
  name: string;
  evidence_count: number;
  /** Derived from precision on read; null without a state row. */
  theta_se: number | null;
  /** Mean calibration confidence over the KC's questions; null when none. */
  confidence: number | null;
  /** Representative track over the KC's calibrated questions. */
  track: string | null;
  cold_start: boolean;
}

export interface CalibrationMaturityAggregate {
  total_kcs: number;
  cold_start_count: number;
  firm_count: number;
  /** firm_count / total_kcs, rounded to four decimals. */
  pct_firm: number;
  /** Median theta_se over KCs with state; null when none. */
  median_theta_se: number | null;
}

export interface CalibrationMaturityResponse {
  rows: CalibrationMaturityRow[];
  aggregate: CalibrationMaturityAggregate;
}

interface KcCalibration {
  confidence: number | null;
  track: string | null;
}

/**
 * Roll per-question calibration up to KCs: mean confidence and the modal track.
 * KCs without a calibrated question are absent.
 */
async function calibrationByKnowledge(db: DbLike): Promise<Map<string, KcCalibration>> {
  const rows = await db
    .select({
      knowledge_id: sql<string>`kc.kc_id`,
      avg_confidence: sql<number | null>`AVG(${item_calibration.confidence})`,
      track_first: sql<
        string | null
      >`(ARRAY_AGG(${item_calibration.track} ORDER BY ${item_calibration.track}))[1]`,
      track_mode: sql<string | null>`MODE() WITHIN GROUP (ORDER BY ${item_calibration.track})`,
    })
    .from(item_calibration)
    .innerJoin(question, eq(question.id, item_calibration.question_id))
    .innerJoin(
      sql`LATERAL jsonb_array_elements_text(${question.knowledge_ids}) AS kc(kc_id)`,
      sql`true`,
    )
    .groupBy(sql`kc.kc_id`);

  const out = new Map<string, KcCalibration>();
  for (const row of rows) {
    out.set(row.knowledge_id, {
      confidence: row.avg_confidence === null ? null : Number(row.avg_confidence),
      // Alphabetical first is a deterministic fallback; MODE is normally populated.
      track: row.track_mode ?? row.track_first,
    });
  }
  return out;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Per-KC rows plus aggregate over every non-archived KC. Missing state means never
 * attempted: cold start, null standard error, zero evidence.
 */
export async function loadCalibrationMaturity(db: DbLike): Promise<CalibrationMaturityResponse> {
  const baseRows = await db
    .select({
      knowledge_id: knowledge.id,
      name: knowledge.name,
      evidence_count: mastery_state.evidence_count,
      theta_precision: mastery_state.theta_precision,
      has_state: sql<boolean>`(${mastery_state.id} IS NOT NULL)`,
    })
    .from(knowledge)
    .leftJoin(
      mastery_state,
      and(eq(mastery_state.subject_id, knowledge.id), eq(mastery_state.subject_kind, 'knowledge')),
    )
    .where(isNull(knowledge.archived_at))
    .orderBy(knowledge.id);

  const calibration = await calibrationByKnowledge(db);

  const rows: CalibrationMaturityRow[] = baseRows.map((row) => {
    const hasState = row.has_state;
    const evidenceCount = hasState ? (row.evidence_count ?? 0) : 0;
    const thetaPrecision = hasState ? (row.theta_precision ?? 1) : 1;
    const cal = calibration.get(row.knowledge_id);
    return {
      knowledge_id: row.knowledge_id,
      name: row.name,
      evidence_count: evidenceCount,
      theta_se: hasState ? thetaSe(thetaPrecision) : null,
      confidence: cal?.confidence ?? null,
      track: cal?.track ?? null,
      cold_start: isColdStart(evidenceCount, thetaPrecision, hasState),
    };
  });

  const totalKcs = rows.length;
  const coldStartCount = rows.filter((r) => r.cold_start).length;
  const firmCount = totalKcs - coldStartCount;
  const pctFirm = totalKcs === 0 ? 0 : Math.round((firmCount / totalKcs) * 10_000) / 10_000;
  const seValues = rows
    .map((r) => r.theta_se)
    .filter((se): se is number => se !== null)
    .sort((a, b) => a - b);

  return {
    rows,
    aggregate: {
      total_kcs: totalKcs,
      cold_start_count: coldStartCount,
      firm_count: firmCount,
      pct_firm: pctFirm,
      median_theta_se: median(seValues),
    },
  };
}
