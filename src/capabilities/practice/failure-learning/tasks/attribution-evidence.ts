// Shapes the attribution model is allowed to see. Pure: the server loader fills
// these from grading, admission and history reads. Nothing here calls a model
// or writes.

import type { ScoringUnitResultT } from '@/core/schema/assessment/judgment';
import type { ResponseSpecT } from '@/core/schema/assessment/response';
import type { ScoringBasisT, ScoringUnitT } from '@/core/schema/assessment/scoring';

/** Same-question history handed to the model, excluding the attempt being attributed. */
export const RECENT_SAME_QUESTION_ATTEMPTS = 5;
/** Failure counts on the attempt's knowledge points. */
export const KNOWLEDGE_FAILURE_WINDOW_DAYS = 14;
/** Newest-first cap. A learner past it still reports the newest window, not a guess. */
export const KNOWLEDGE_FAILURE_SCAN_LIMIT = 200;

const TEXT_CAP = 400;
const MAX_EVIDENCE_UNITS = 12;

export interface GradingEvidenceObservation {
  slot_id: string | null;
  evidence_id: string | null;
  observation_md: string;
}

/** One scoring unit from the effective evaluation that was wrong, missed, or short of full marks. */
export interface GradingEvidenceUnit {
  scoring_unit_id: string;
  part_id: string | null;
  points_awarded: number | null;
  points_full: number | null;
  reason_md: string | null;
  wrong_option_ids: string[];
  missed_option_ids: string[];
  model_observations: GradingEvidenceObservation[];
}

export interface GradingEvidence {
  units: GradingEvidenceUnit[];
}

export interface AttemptBehaviorEvidence {
  /** Learner self-rating when recorded. Null means unrecorded, not zero. */
  self_confidence: number | null;
  duration_ms: number | null;
  hints_used: number | null;
  final_hint_level: number | null;
}

/** Pitfall of the solution prior for a part this attempt actually lost. */
export interface FailedPartPitfall {
  part_id: string;
  mechanism_md: string;
  trigger_md: string;
}

export interface RecentSameQuestionAttempt {
  attempt_event_id: string;
  created_at: string;
  outcome: 'failure' | 'success' | 'partial' | 'pending' | 'unknown';
  cause_category: string | null;
  cause_confidence: number | null;
}

export interface KnowledgeFailureCount14d {
  knowledge_id: string;
  failure_count: number;
}

export interface PrerequisiteMasteryEvidence {
  knowledge_id: string;
  name: string | null;
  /** The attempt's knowledge point that lists this node as a direct prerequisite. */
  supports_knowledge_id: string;
  /** Null when this prerequisite has no observed mastery of its own. */
  band: '萌芽' | '成长' | '稳固' | '精熟' | null;
  low_confidence: boolean | null;
}

export interface AttributionEvidence {
  /** Null on a legacy attempt that has no effective evaluation. */
  grading_evidence: GradingEvidence | null;
  behavior: AttemptBehaviorEvidence;
  failed_part_pitfalls: FailedPartPitfall[];
  recent_same_question: RecentSameQuestionAttempt[];
  knowledge_failure_counts_14d: KnowledgeFailureCount14d[];
  prerequisite_mastery: PrerequisiteMasteryEvidence[];
}

function clip(text: string | undefined | null): string | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length <= TEXT_CAP ? trimmed : trimmed.slice(0, TEXT_CAP);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function behaviorFromAttemptPayload(
  payload: Record<string, unknown> | null | undefined,
): AttemptBehaviorEvidence {
  const source = payload ?? {};
  return {
    self_confidence: finiteNumber(source.self_confidence),
    duration_ms: finiteNumber(source.duration_ms),
    hints_used: nonNegativeInt(source.hints_used),
    final_hint_level: nonNegativeInt(source.final_hint_level),
  };
}

function fullPoints(unit: ScoringUnitT | undefined): number | null {
  if (!unit) return null;
  if (unit.points != null) return unit.points;
  const levels = unit.level_points;
  if (!levels) return null;
  const values = Object.values(levels);
  if (values.length === 0) return null;
  return Math.max(...values);
}

function pointsShort(awarded: number | null, full: number | null): boolean {
  if (awarded != null && full != null) return awarded + 1e-9 < full;
  return awarded === 0 && (full == null || full > 0);
}

function unitLostPoints(
  result: Extract<ScoringUnitResultT, { status: 'scored' }>,
  unit: ScoringUnitT | undefined,
): boolean {
  const set = result.comparison?.set;
  if ((set?.wrong_ids?.length ?? 0) > 0 || (set?.miss_ids?.length ?? 0) > 0) return true;
  if (result.scored_because === 'blank_marked_zero') return true;
  const partial = result.partial_unknown_points;
  if (partial && partial.correct_count < partial.total_count) return true;
  const full = fullPoints(unit);
  const awarded =
    result.points_awarded ??
    (result.matched?.level_id && unit?.level_points
      ? (unit.level_points[result.matched.level_id] ?? null)
      : null);
  return pointsShort(awarded, full);
}

function toEvidenceUnit(
  result: Extract<ScoringUnitResultT, { status: 'scored' }>,
  unit: ScoringUnitT | undefined,
  partId: string | null,
): GradingEvidenceUnit {
  const full = fullPoints(unit);
  const awarded =
    result.points_awarded ??
    (result.matched?.level_id && unit?.level_points
      ? (unit.level_points[result.matched.level_id] ?? null)
      : null);
  const observations: GradingEvidenceObservation[] = [];
  for (const observation of result.model_observations ?? []) {
    const text = clip(observation.observation_md);
    if (!text) continue;
    observations.push({
      slot_id: observation.slot_id ?? null,
      evidence_id: observation.evidence_id ?? null,
      observation_md: text,
    });
  }
  return {
    scoring_unit_id: result.scoring_unit_id,
    part_id: partId,
    points_awarded: awarded,
    points_full: full,
    reason_md: clip(result.feedback_md),
    wrong_option_ids: result.comparison?.set?.wrong_ids ?? [],
    missed_option_ids: result.comparison?.set?.miss_ids ?? [],
    model_observations: observations,
  };
}

/**
 * Pull the effective evaluation's lost units. `failedPartIds` is the issued
 * parts those units belong to, so the solution-prior read stays on the parts
 * the learner actually missed.
 */
export function extractGradingEvidence(input: {
  unitResults: readonly ScoringUnitResultT[];
  scoringBasis: ScoringBasisT | null;
  responseSpec: ResponseSpecT | null;
  issuedPartIds: readonly string[];
}): { evidence: GradingEvidence; failedPartIds: string[] } {
  const unitById = new Map(
    (input.scoringBasis?.units ?? []).map((unit) => [unit.scoring_unit_id, unit] as const),
  );
  const partBySlot = new Map(
    (input.responseSpec?.slots ?? []).map((slot) => [slot.slot_id, slot.part_id] as const),
  );
  const issued = new Set(input.issuedPartIds);
  const partIdFor = (unitId: string): string | null => {
    const unit = unitById.get(unitId);
    if (!unit) return null;
    for (const slotId of unit.slot_refs) {
      const partId = partBySlot.get(slotId);
      if (partId && issued.has(partId)) return partId;
    }
    return null;
  };

  const scored = input.unitResults.filter(
    (result): result is Extract<ScoringUnitResultT, { status: 'scored' }> =>
      result.status === 'scored',
  );
  const lostIds = new Set(
    scored
      .filter((result) => unitLostPoints(result, unitById.get(result.scoring_unit_id)))
      .map((result) => result.scoring_unit_id),
  );
  // Observations ride along even when points are absent: a photo grade may have
  // no numeric loss and still be the only record of what the judge saw.
  const chosen = scored
    .filter(
      (result) =>
        lostIds.has(result.scoring_unit_id) || (result.model_observations?.length ?? 0) > 0,
    )
    .slice(0, MAX_EVIDENCE_UNITS);
  const units = chosen.map((result) =>
    toEvidenceUnit(result, unitById.get(result.scoring_unit_id), partIdFor(result.scoring_unit_id)),
  );
  const failedPartIds = [
    ...new Set(
      units.flatMap((unit) =>
        unit.part_id && lostIds.has(unit.scoring_unit_id) ? [unit.part_id] : [],
      ),
    ),
  ];
  return { evidence: { units }, failedPartIds };
}
