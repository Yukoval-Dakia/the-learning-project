// Sealed assessment settlement ledger shared by settlement and learner reads.
// Write, replay and candidate reconstruction remain with the settlement owner.

import { and, eq, gte, or, sql } from 'drizzle-orm';
import { settlementReversions } from '@/core/assessment-settlement-liveness';
import type {
  CandidateReplayInput,
  SealedCandidateInput,
  candidateObservations,
} from '@/core/scheduling/candidate';
import type { FsrsRatingLabel, KcObservation } from '@/core/schema/assessment';
import type { KcEvidenceApply, KcWrongCauseT } from '@/core/schema/assessment/kc-mastery-evidence';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import type { AbilityGlobalByKnowledgeId } from '@/kernel/read-models/mastery-state';

/**
 * Receipt for one family observation. Revert/re-apply needs exact inverse inputs:
 * `folded` says whether the residual entered the mean, and `residual` is the weighted,
 * clamped value to subtract.
 */
export interface FamilyFoldRecord {
  familyKey: string;
  folded: boolean;
  residual: number;
}

const ASSESSMENT_SETTLEMENT_ACTION = 'experimental:assessment_settlement';

export interface FsrsSubject {
  kind: 'question' | 'knowledge';
  id: string;
}

interface ThetaApply {
  applied: true;
  outcome: 0 | 1;
  knowledgeIds: string[];
  /** Present when KCs do not share one full-weight direction. */
  kcEvidence?: KcEvidenceApply[];
  anchorQuestionId: string;
  anchorDifficulty: number;
  anchorKind: string;
  anchorSource: string;
  familyPrimaryKnowledgeId: string | null;
  abilityGlobalByKnowledgeId: AbilityGlobalByKnowledgeId;
}

/**
 * YUK-439 (ADR-0043 Amendment A4) — 联合标定证据的封存输入。theta abstain（partial /
 * mixed bits）不排除证据：连续分数照样进标定账本（A4 部分得分条款）。null = 本次
 * 结算不产生标定证据（manual/self_report/assisted 被 D15/D16 排除，或分数未知
 * unsupported/partial_unknown，或锚不可解析）。sealed 在 plan 上（replay 稳定）。
 */
export interface CalibrationEvidencePlan {
  /** 被标定题（锚推导的 anchor question id，同 theta.anchorQuestionId 的推导）。 */
  questionId: string;
  /** 锚题 1-5 难度（provenance 备档）。 */
  difficulty: number;
  /** 锚题 primary KC（thetaBefore 读取键；无 KC 的题 null → θ̂ 快照按冷启 0）。 */
  primaryKnowledgeId: string | null;
  /** issuance 容器 ref（来源解析：paper/placement/probe/ingestion/worksheet）。 */
  containerRef: string | null;
}

export interface SettlementPlan {
  kind: 'plan';
  groupId: string;
  submissionId: string;
  evaluationId: string;
  attempt: number;
  /** Frozen member max(submitted_at). A legacy single member keeps its own submitted_at. */
  occurrenceAt: string;
  /** When the evaluation completed. Distinct from the occurrence. */
  evaluatedAt: string;
  provenance: { source: 'automatic' | 'manual' | 'self_report'; assisted: boolean };
  verdict: { verdict: string; reason: string; points: number | null; normalized: number | null };
  /** null means do not schedule. Unsupported and unratable verdicts stay null. */
  rating: 'again' | 'hard' | 'good' | null;
  /** 'user' = explicit activation choice or manual/self_report provenance. */
  ratingSource: 'verdict' | 'user' | 'none';
  /** Sealed on the settlement evidence. Replay keeps this mapping instead of today's labels. */
  scopeVersion: number;
  /** Non-synthetic KC ids in this scope. */
  scopeKcIds: string[];
  /** One knowledge card per scope KC. An empty scope uses the group-root question card. */
  fsrsSubjects: FsrsSubject[];
  /**
   * Per-KC FSRS ratings sealed with the plan. Absence is a legacy plan and keeps
   * the shared `rating` behaviour; an abstaining KC is present with `rating: null`.
   */
  kcRatings?: Array<{ knowledgeId: string; rating: FsrsRatingLabel | null }>;
  kcObservations: KcObservation[];
  /** Which KC dragged the attempt. null only on plans sealed before this field existed. */
  kcWrongCause?: KcWrongCauseT;
  theta: ThetaApply | { applied: false; abstainReason: string };
  /** exact only when every unit was deterministic. Mixed routes must not look exact. */
  judgeRoute: string;
  difficultyLabelStreamItemId: string | null;
  /** YUK-439 — 联合标定证据输入（null = 本次不产生证据，见 CalibrationEvidencePlan）。 */
  calibration: CalibrationEvidencePlan | null;
  forgettingInput?: SealedCandidateInput;
  forgettingEngine?: 'fsrs' | 'forgetting_candidate';
  forgettingSuppressed?: boolean;
  forgettingExcludedEvidence?: Array<
    Extract<ReturnType<typeof candidateObservations>[number], { kind: 'excluded' }>
  >;
  forgettingReplayInputs?: Array<
    CandidateReplayInput & { subject_kind: FsrsSubject['kind']; subject_id: string }
  >;
}

export interface AppliedSettlementEvent {
  /** A retained scheduling segment; its former theta/calibration is already undone. */
  fsrsOnly: boolean;
  id: string;
  groupId: string;
  evaluationId: string;
  occurrenceMs: number;
  createdMs: number;
  /** Subjects actually touched. The replay closure intersects on these. */
  subjects: Set<string>;
  /** FSRS subjects actually written. An empty list means replay must skip FSRS too. */
  fsrsApplied: string[];
  familyObservationRecorded: boolean;
  /** Family fold left behind. null was not touched, so revert has no mean to undo. */
  familyFold: FamilyFoldRecord | null;
  inputs: SettlementPlan;
}

export interface SettlementEventRow {
  fsrsOnly: boolean;
  id: string;
  createdMs: number;
  groupId: string | null;
  evaluationId: string | null;
  effect: string | null;
  occurrenceMs: number | null;
  subjects: Set<string>;
  /** FSRS subjects written. User-rating lookup and replay both trust this list. */
  fsrsApplied: string[];
  familyObservationRecorded: boolean;
  familyFold: FamilyFoldRecord | null;
  inputs: SettlementPlan | null;
  supersedesSettlementEventId: string | null;
  revertedIds: string[];
  replayOf: string | null;
}

export interface CalibrationSettlement {
  id: string;
  groupId: string;
  evaluationId: string;
  inputs: SettlementPlan;
}

export function coerceMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function subjectKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function planFromPayload(raw: unknown): SettlementPlan | null {
  if (raw === null || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.kind !== 'plan') return null;
  if (typeof p.groupId !== 'string' || typeof p.evaluationId !== 'string') return null;
  if (typeof p.occurrenceAt !== 'string' || coerceMs(p.occurrenceAt) === null) return null;
  if (typeof p.fsrsSubjects === 'undefined' || !Array.isArray(p.fsrsSubjects)) return null;
  if (!Array.isArray(p.kcObservations) || typeof p.theta !== 'object' || p.theta === null) {
    return null;
  }
  return p as unknown as SettlementPlan;
}

/** A missing or unreadable family_fold is null. There is then no fold to undo. */
function parseFamilyFold(raw: unknown): FamilyFoldRecord | null {
  if (raw === null || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.familyKey !== 'string' || typeof f.residual !== 'number') return null;
  if (typeof f.folded !== 'boolean') return null;
  return { familyKey: f.familyKey, folded: f.folded, residual: f.residual };
}

function decodeSettlementEvent(row: {
  id: string;
  created_at: Date;
  payload: unknown;
}): SettlementEventRow {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  const effects = (p.effects ?? {}) as Record<string, unknown>;
  const subjects = new Set<string>(
    Array.isArray(effects.subjects)
      ? (effects.subjects as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
  );
  return {
    id: row.id,
    fsrsOnly: p.fsrs_only === true,
    createdMs: coerceMs(row.created_at) ?? 0,
    groupId: typeof p.evaluation_group_id === 'string' ? p.evaluation_group_id : null,
    evaluationId: typeof p.evaluation_id === 'string' ? p.evaluation_id : null,
    effect: typeof p.effect === 'string' ? p.effect : null,
    occurrenceMs: coerceMs(p.occurrence_at as string | undefined),
    subjects,
    fsrsApplied: Array.isArray(effects.fsrs_applied)
      ? (effects.fsrs_applied as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
    familyObservationRecorded: effects.family_observation_recorded === true,
    familyFold: parseFamilyFold(effects.family_fold),
    inputs: planFromPayload(p.replay_inputs),
    supersedesSettlementEventId:
      typeof p.supersedes_settlement_event_id === 'string'
        ? p.supersedes_settlement_event_id
        : null,
    revertedIds: Array.isArray(p.reverted_settlement_event_ids)
      ? (p.reverted_settlement_event_ids as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
      : [],
    replayOf: typeof p.replay_of === 'string' ? p.replay_of : null,
  };
}

/** `occurredSince` keeps rows written then, or whose sealed occurrence is then or later. */
export async function loadSettlementEvents(
  tx: Db | Tx,
  occurredSince?: Date,
): Promise<SettlementEventRow[]> {
  const rows = await tx
    .select({ id: event.id, created_at: event.created_at, payload: event.payload })
    .from(event)
    .where(
      occurredSince
        ? and(
            eq(event.action, ASSESSMENT_SETTLEMENT_ACTION),
            or(
              gte(event.created_at, occurredSince),
              sql`${event.payload}->>'occurrence_at' >= ${occurredSince.toISOString()}`,
            ),
          )
        : eq(event.action, ASSESSMENT_SETTLEMENT_ACTION),
    );
  return rows.map(decodeSettlementEvent);
}

/**
 * Anchor questions of the live family observations receipted under `familyKey`: the same
 * receipts evidence_count folds and revert unfolds. Loads only this family's receipts and
 * the settlements that revert them, which is all liveness needs. Inside a replay the members
 * being reverted stay visible until the settlement that reverts them is written.
 */
export async function liveFamilyObservationQuestionIds(
  tx: Tx,
  familyKey: string,
): Promise<Set<string>> {
  const familyReceiptIds = sql`SELECT receipt.id FROM ${event} AS receipt
    WHERE receipt.action = ${ASSESSMENT_SETTLEMENT_ACTION}
      AND receipt.payload->'effects'->'family_fold'->>'familyKey' = ${familyKey}`;
  const rows = await tx
    .select({ id: event.id, created_at: event.created_at, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, ASSESSMENT_SETTLEMENT_ACTION),
        or(
          sql`${event.id} IN (${familyReceiptIds})`,
          sql`${event.payload}->>'supersedes_settlement_event_id' IN (${familyReceiptIds})`,
          sql`${event.payload}->>'replay_of' IN (${familyReceiptIds})`,
          sql`${event.payload}->'reverted_settlement_event_ids' ?| ARRAY(${familyReceiptIds})`,
        ),
      ),
    );
  const questionIds = new Set<string>();
  for (const member of liveAppliedSettlements(rows.map(decodeSettlementEvent))) {
    if (member.familyFold?.familyKey === familyKey && member.inputs.theta.applied) {
      questionIds.add(member.inputs.theta.anchorQuestionId);
    }
  }
  return questionIds;
}

/** Live settlements plus user FSRS segments retained after their verdict was superseded. */
export function liveAppliedSettlements(rows: SettlementEventRow[]): AppliedSettlementEvent[] {
  const { dead, deadFsrs } = settlementReversions(rows);
  const live: AppliedSettlementEvent[] = [];
  for (const row of rows) {
    if (row.effect !== 'applied' || row.occurrenceMs === null) continue;
    const retainedFsrs =
      dead.has(row.id) &&
      !deadFsrs.has(row.id) &&
      row.inputs?.ratingSource === 'user' &&
      row.fsrsApplied.length > 0;
    if (dead.has(row.id) && !retainedFsrs) continue;
    if (row.inputs === null) continue; // An applied row with no replay inputs cannot enter the closure.
    const fsrsOnly = retainedFsrs || row.fsrsOnly;
    live.push({
      fsrsOnly,
      id: row.id,
      groupId: row.groupId ?? '',
      evaluationId: row.evaluationId ?? '',
      occurrenceMs: row.occurrenceMs,
      createdMs: row.createdMs,
      subjects: fsrsOnly ? new Set(row.fsrsApplied) : row.subjects,
      fsrsApplied: row.fsrsApplied,
      familyObservationRecorded: !fsrsOnly && row.familyObservationRecorded,
      familyFold: fsrsOnly ? null : row.familyFold,
      inputs: fsrsOnly
        ? { ...row.inputs, theta: { applied: false, abstainReason: 'retained_user_rating' } }
        : row.inputs,
    });
  }
  return live;
}

/** Calibration can survive learning abstention, but never a superseded verdict or FSRS-only retention. */
export function liveCalibrationSettlements(rows: SettlementEventRow[]): CalibrationSettlement[] {
  const { dead } = settlementReversions(rows);
  const live: CalibrationSettlement[] = [];
  for (const row of rows) {
    if (dead.has(row.id) || row.fsrsOnly || row.occurrenceMs === null || row.inputs === null)
      continue;
    if (row.effect !== 'applied') {
      const plan = row.inputs;
      const score = plan.verdict?.normalized;
      if (
        row.effect !== 'ineligible' ||
        plan.provenance?.source !== 'automatic' ||
        plan.provenance.assisted !== false ||
        typeof score !== 'number' ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1 ||
        typeof plan.calibration?.questionId !== 'string' ||
        !plan.calibration.questionId.trim()
      )
        continue;
    }
    live.push({
      id: row.id,
      groupId: row.groupId ?? '',
      evaluationId: row.evaluationId ?? '',
      inputs: row.inputs,
    });
  }
  return live;
}
