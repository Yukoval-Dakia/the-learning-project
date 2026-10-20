import { settlementReversions } from '@/core/assessment-settlement-liveness';
// Learning settlement for one activation, on the caller's transaction.
// The caller already holds learning-state lock G. This layer takes the FSRS subject
// locks first. updateThetaForAttempt then takes its own fsrs and ability_global locks.
// Do not open a top-level transaction. Replay uses a savepoint.
// Occurrence time is the frozen submission time. evaluated_at and activated_at stay separate.
// A regrade is not extra practice: revert and apply share one snapshot, so evidence_count does not grow by one.
// One shared theta update, and only when every non-abstain KC shares the same bit.
// Mixed bits abstain. There is no fractional theta and no second IRT.
// manual and self_report write FSRS only. Assisted scores stay, while theta, hard-mastery,
// and calibration are excluded. An explicit user rating may still write FSRS.
// The replay set is a deterministic fixpoint of later live settlements whose subjects intersect.
// Revert newest to oldest, then reapply in original occurrence order from the sealed inputs.
// Reapply does not re-judge. A family mean that cannot be un-folded, or a later trace from a
// non-settlement writer, is replay_required. The savepoint rolls back every revert already done,
// the receipt is failed_pending, and learning state stays as it was before activation.
// A user rating on the replaced settlement is not overwritten by a judge correction.
// Skip that FSRS revert and this FSRS apply. Theta still corrects on its own.
// Each settlement event seals both the replaced side and the effective side.
// replay_required is the worklist. It is not a settled fact.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  SYNTHETIC_SUBJECT_ROOT_RE,
  writeAttemptSnapshotBrackets,
} from '@/capabilities/practice/public';
import { scheduleReview } from '@/core/fsrs';
import { canonicalHash } from '@/core/migration/canonical';
import type {
  ExecutionPlanT,
  KcObservation,
  ResponseSpecT,
  ScoringBasisT,
} from '@/core/schema/assessment';
import {
  EvaluationProvenance,
  SETTLEMENT_SCOPE_VERSION,
  deriveCoarseVerdict,
  localizeKcObservations,
  projectIssuedScoringBasis,
  ratingForVerdict,
  resolveThetaDecision,
} from '@/core/schema/assessment';
import {
  type SchedulingState,
  SchedulingStateSchema,
  isCandidateState,
} from '@/core/schema/scheduling-state';
import type { Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  difficulty_calibration_label,
  evaluation,
  evaluation_effective_head,
  event,
  mastery_state,
  material_fsrs_state,
  question,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import {
  CandidateFactSchema,
  type CandidateReplayInput,
  type SealedCandidateInput,
  candidateObservations,
  candidatePointsForAdmission,
  candidateRetention,
  initialCandidateState,
  rebuildCandidate,
  sealCandidateFact,
  validateCandidateInput,
} from '@/server/fsrs/candidate';
import { selectedForgettingEngine } from '@/server/fsrs/engine-selection';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import {
  type FamilyFoldRecord,
  recordFamilyObservationForAttempt,
  unfoldFamilyCalibration,
} from '@/server/mastery/personalized-difficulty';
import {
  clearCalibrationBelowThreshold,
  recordDifficultyCalibrationLabel,
} from '@/server/mastery/recalibration';
import {
  type AbilityGlobalByKnowledgeId,
  getMasteryState,
  resolveAbilityGlobalByKnowledgeId,
  updateThetaForAttempt,
} from '@/server/mastery/state';
import { orchestrateCascadeRevert } from '@/server/revert/cascade-revert';
import type { ActivationEffect, ActivationSettleInput } from './activate';
import { loadAssessmentLearningScope } from './learning-scope';

export const ASSESSMENT_SETTLEMENT_ACTION = 'experimental:assessment_settlement';
export const ASSESSMENT_SETTLEMENT_VERSION = 1 as const;

interface QuestionLite {
  id: string;
  knowledge_ids: string[];
  difficulty: number;
  kind: string;
  source: string;
}

interface FsrsSubject {
  kind: 'question' | 'knowledge';
  id: string;
}

interface ThetaApply {
  applied: true;
  outcome: 0 | 1;
  knowledgeIds: string[];
  anchorQuestionId: string;
  anchorDifficulty: number;
  anchorKind: string;
  anchorSource: string;
  familyPrimaryKnowledgeId: string | null;
  abilityGlobalByKnowledgeId: AbilityGlobalByKnowledgeId;
}

interface SettlementPlan {
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
  kcObservations: KcObservation[];
  theta: ThetaApply | { applied: false; abstainReason: string };
  /** exact only when every unit was deterministic. Mixed routes must not look exact. */
  judgeRoute: string;
  difficultyLabelStreamItemId: string | null;
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

interface AppliedSettlementEvent {
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

type ReplayRequired =
  | { kind: 'family_fold_missing'; settlementEventId: string }
  | { kind: 'family_fold_drift'; settlementEventId: string }
  | { kind: 'unreplayable_member'; settlementEventId: string; reason: string }
  | { kind: 'unattributed_newer_write'; subject: string; detail: string }
  | { kind: 'revert_failed'; settlementEventId: string; refusal: string }
  | { kind: 'reapply_failed'; settlementEventId: string; reason: string };

function coerceMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function normalizeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
}

function contentKcs(ids: readonly string[]): string[] {
  return normalizeIds(ids).filter((id) => !SYNTHETIC_SUBJECT_ROOT_RE.test(id));
}

function subjectKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/** Parts cited by the unit's slots. No slot ref is the group, marked by an empty set. */
function unitPartIdsOf(basis: ScoringBasisT, spec: ResponseSpecT): Map<string, Set<string>> {
  const partBySlot = new Map(spec.slots.map((s) => [s.slot_id, s.part_id] as const));
  const map = new Map<string, Set<string>>();
  for (const unit of basis.units) {
    const parts = new Set<string>();
    for (const slotId of [...unit.slot_refs, ...unit.evidence_slot_refs]) {
      const partId = partBySlot.get(slotId);
      if (partId !== undefined) parts.add(partId);
    }
    map.set(unit.scoring_unit_id, parts);
  }
  return map;
}

/** Executor kind. Assignment coverage is already unique, so this only reads it. */
function unitExecutorKinds(plan: ExecutionPlanT): Map<string, string> {
  const map = new Map<string, string>();
  for (const assignment of plan.assignments) {
    for (const unitId of assignment.scoring_unit_ids) {
      map.set(unitId, assignment.executor.kind);
    }
  }
  return map;
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

interface SettlementScope {
  preserveScheduling: boolean;
  difficultyLabelStreamItemId: string | null;
  frozenAbilityGlobalByKnowledgeId?: AbilityGlobalByKnowledgeId;
  groupRow: QuestionLite | null;
  partRows: Map<string, QuestionLite>;
  spec: ResponseSpecT;
  basis: ScoringBasisT;
  plan: ExecutionPlanT;
  issuedPartIds: string[];
  fullScope: boolean;
  frozenLearningScope: boolean;
  capture: NonNullable<ActivationSettleInput['forgettingCapture']>;
  assistance: 'independent' | 'assisted' | 'unknown';
}

async function loadScope(tx: Tx, input: ActivationSettleInput): Promise<SettlementScope> {
  const [revision] = await tx
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, input.submission.revision_id))
    .limit(1);
  if (!revision) {
    throw new Error(
      `assessment settlement: revision '${input.submission.revision_id}' missing — submission coordinate corrupt (fail-closed)`,
    );
  }
  const spec = revision.response_spec as ResponseSpecT;
  const basis = projectIssuedScoringBasis(
    revision,
    input.inputScope?.issued_part_ids ?? input.issuance.part_ids,
  );
  const plan = revision.execution_plan as ExecutionPlanT;
  const partIds = input.inputScope?.issued_part_ids ?? input.issuance.part_ids;
  const fullScope = partIds.length === revision.structure.parts.length;
  const wanted = new Set<string>([input.questionGroupId, ...partIds]);
  const frozen = await loadAssessmentLearningScope(
    tx,
    input.submission.submission_id,
    input.questionGroupId,
  );
  const rows = frozen
    ? frozen.questions.filter((row) => wanted.has(row.id))
    : await tx
        .select({
          id: question.id,
          knowledge_ids: question.knowledge_ids,
          difficulty: question.difficulty,
          kind: question.kind,
          source: question.source,
        })
        .from(question)
        .where(inArray(question.id, [...wanted]));
  const byId = new Map<string, QuestionLite>(rows.map((r) => [r.id, r as QuestionLite]));
  const partRows = new Map<string, QuestionLite>();
  for (const partId of partIds) {
    const row = byId.get(partId);
    if (row) partRows.set(partId, row);
  }
  const [original] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.id, `evt_assessment_${input.submission.submission_id}`),
        eq(event.action, 'experimental:assessment_attempt'),
      ),
    );
  const [issuanceReceipt] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_issuance'),
        eq(event.subject_kind, 'issuance'),
        eq(event.subject_id, input.issuance.issuance_id),
      ),
    )
    .limit(1);
  const [submissionReceipt] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_submission'),
        eq(event.subject_kind, 'submission'),
        eq(event.subject_id, input.submission.submission_id),
      ),
    )
    .limit(1);
  const assistance = submissionReceipt?.payload.assistance;
  const status =
    assistance && typeof assistance === 'object' && 'status' in assistance
      ? assistance.status
      : 'unknown';
  const numeric = (key: string) =>
    typeof original?.payload[key] === 'number' ? original.payload[key] : null;
  return {
    frozenLearningScope: frozen !== null,
    capture: input.forgettingCapture ?? {
      hints_used: numeric('hints_used'),
      final_hint_level: numeric('final_hint_level'),
      self_confidence: numeric('self_confidence'),
      latency_ms: numeric('duration_ms'),
    },
    assistance: status === 'independent' || status === 'assisted' ? status : 'unknown',
    preserveScheduling:
      issuanceReceipt?.payload.mode === 'capture_existing' &&
      issuanceReceipt.payload.scheduling_policy === 'preserve',
    difficultyLabelStreamItemId:
      typeof original?.payload.stream_item_id === 'string' ? original.payload.stream_item_id : null,
    frozenAbilityGlobalByKnowledgeId: frozen?.ability_global_by_knowledge_id,
    groupRow: byId.get(input.questionGroupId) ?? null,
    partRows,
    spec,
    basis,
    plan,
    issuedPartIds: partIds,
    fullScope,
  };
}

function derivePlan(input: ActivationSettleInput, scope: SettlementScope): SettlementPlan {
  const groupKcs = contentKcs(scope.groupRow?.knowledge_ids ?? []);
  const partKcIds = new Map<string, string[]>();
  // A full issue keeps group labels. A subset keeps only the issued parts.
  // Virtual parts and group-only units fall back to the group. Unissued physical parts stay out.
  const groupEvidence = scope.basis.units.some(
    (unit) => unit.slot_refs.length === 0 && unit.evidence_slot_refs.length === 0,
  );
  const scopeSet = new Set<string>(scope.fullScope || groupEvidence ? groupKcs : []);
  // A physical part uses its own knowledge ids. A virtual part has no row, so it uses the group.
  // An empty list has no part-local meaning and also uses the group.
  // Full-scope virtual-part fallback and theta anchors retain the v1 mapping.
  const localizedParts = scope.fullScope ? [...scope.partRows.keys()] : scope.issuedPartIds;
  for (const partId of localizedParts) {
    const kcs = contentKcs(scope.partRows.get(partId)?.knowledge_ids ?? []);
    const localized = kcs.length > 0 ? kcs : groupKcs;
    partKcIds.set(partId, localized);
    for (const kc of localized) scopeSet.add(kc);
  }
  const scopeKcIds = [...scopeSet].sort();

  const verdict = deriveCoarseVerdict(
    { status: input.evaluation.status, aggregate: input.evaluation.aggregate ?? null },
    scope.basis,
  );
  const provenance = EvaluationProvenance.catch({ source: 'automatic', assisted: false }).parse(
    input.evaluation.provenance ?? {},
  );
  const unitPartIds = unitPartIdsOf(scope.basis, scope.spec);
  const observations = localizeKcObservations(scope.basis, input.evaluation.unit_results, {
    unitPartIds,
    partKcIds,
    groupKcIds: scopeKcIds,
  });
  const thetaDecision = resolveThetaDecision(observations, provenance);

  const rating = scope.preserveScheduling
    ? null
    : (input.userRating ??
      (provenance.assisted && provenance.source === 'automatic'
        ? null
        : ratingForVerdict(verdict.verdict)));
  const ratingSource: SettlementPlan['ratingSource'] =
    rating === null
      ? 'none'
      : input.userRating !== undefined || provenance.source !== 'automatic'
        ? 'user'
        : 'verdict';
  const fsrsSubjects: FsrsSubject[] =
    scopeKcIds.length > 0
      ? scopeKcIds.map((id) => ({ kind: 'knowledge' as const, id }))
      : [{ kind: 'question' as const, id: input.questionGroupId }];

  const executorKinds = unitExecutorKinds(scope.plan);
  const scoredUnitIds = new Set(
    input.evaluation.unit_results
      .filter((r) => r.status === 'scored')
      .map((r) => r.scoring_unit_id),
  );
  const judgeRoute =
    scoredUnitIds.size > 0 &&
    [...scoredUnitIds].every((id) => executorKinds.get(id) === 'deterministic')
      ? 'exact'
      : 'contract_evaluation';

  let theta: SettlementPlan['theta'];
  if (thetaDecision.kind === 'abstain') {
    theta = { applied: false, abstainReason: thetaDecision.reason };
  } else {
    // One part: that physical question row, because item calibration is keyed by row.
    // Across parts: the group root stands for the difficulty and family keys.
    const partsCovering = new Set<string>();
    const updateSet = new Set(thetaDecision.knowledgeIds);
    for (const [partId, kcs] of partKcIds) {
      if (kcs.some((kc) => updateSet.has(kc))) partsCovering.add(partId);
    }
    const anchor =
      partsCovering.size === 1
        ? (scope.partRows.get([...partsCovering][0]) ?? scope.groupRow)
        : scope.groupRow;
    if (!anchor) {
      theta = { applied: false, abstainReason: 'anchor_unavailable' };
    } else {
      theta = {
        applied: true,
        outcome: thetaDecision.outcome,
        knowledgeIds: thetaDecision.knowledgeIds,
        anchorQuestionId: anchor.id,
        anchorDifficulty: anchor.difficulty,
        anchorKind: anchor.kind,
        anchorSource: anchor.source,
        familyPrimaryKnowledgeId: anchor.knowledge_ids[0] ?? null,
        abilityGlobalByKnowledgeId: {}, // Filled later by derivePlanAsync. An empty map here is not the frozen pin.
      };
    }
  }

  const occurrence = input.inputScope?.occurrence_at ?? input.submission.submitted_at.toISOString();
  const selfReport = ratingSource === 'user';
  const points = selfReport
    ? [
        {
          maximum: 1,
          earned: rating === 'good' ? 1 : rating === 'hard' ? 0.5 : 0,
          shares: fsrsSubjects.map((subject) => ({
            skillId: subject.id,
            share: 1 / fsrsSubjects.length,
          })),
        },
      ]
    : scope.basis.units.flatMap((unit) => {
        const result = input.evaluation.unit_results.find(
          (r) => r.scoring_unit_id === unit.scoring_unit_id,
        );
        if (result?.status !== 'scored') return [];
        const maximum =
          unit.criterion.kind === 'holistic_level'
            ? Math.max(0, ...Object.values(unit.level_points ?? {}))
            : unit.points;
        const earned =
          unit.criterion.kind === 'holistic_level'
            ? result.matched?.level_id
              ? unit.level_points?.[result.matched.level_id]
              : null
            : result.points_awarded;
        if (maximum == null || maximum <= 0 || earned == null) return [];
        const scoreWeight =
          scope.basis.aggregation.kind === 'weighted_sum'
            ? (scope.basis.aggregation.weights[unit.scoring_unit_id] ?? 0)
            : 1;
        if (scoreWeight <= 0) return [];
        const partIds = unitPartIds.get(unit.scoring_unit_id);
        const kcs = partIds?.size
          ? [...new Set([...partIds].flatMap((id) => partKcIds.get(id) ?? scopeKcIds))]
          : scopeKcIds;
        const ids = kcs.length ? kcs : scopeKcIds.length === 0 ? [input.questionGroupId] : [];
        return [
          {
            maximum: maximum * scoreWeight,
            earned: earned * scoreWeight,
            // A partial total cannot identify which of several skills earned it.
            shares:
              ids.length > 1 && earned > 0 && earned < maximum
                ? []
                : ids.map((id) => ({ skillId: id, share: 1 / ids.length })),
          },
        ];
      });
  const capture = scope.capture;
  const help =
    scope.assistance === 'unknown'
      ? 'unknown'
      : scope.assistance === 'assisted' ||
          (!selfReport && provenance.assisted) ||
          (capture.hints_used ?? 0) > 0 ||
          (capture.final_hint_level ?? 0) > 0
        ? (capture.final_hint_level ?? 0) >= 3
          ? 'answer'
          : (capture.final_hint_level ?? 0) >= 2
            ? 'deep'
            : 'shallow'
        : 'none';
  const forgettingInput = sealCandidateFact(
    CandidateFactSchema.parse({
      submissionId: input.submission.submission_id,
      evaluationId: input.evaluation.evaluation_id,
      occurredAt: new Date(occurrence),
      revisionId: input.submission.revision_id,
      context: scope.groupRow ? `${scope.groupRow.source}:${scope.groupRow.kind}` : null,
      source: selfReport ? 'self_report' : 'judged',
      judgment: selfReport
        ? 'deterministic'
        : verdict.verdict === 'unsupported'
          ? 'unknown'
          : judgeRoute === 'exact'
            ? 'deterministic'
            : 'admitted',
      judgeRevision: selfReport
        ? 'self-report-rating-v1'
        : `${input.submission.revision_id}:${input.evaluation.plan_digest ?? canonicalHash(scope.plan)}`,
      help,
      guess: 'unknown',
      confidence:
        capture.self_confidence == null
          ? 'unknown'
          : capture.self_confidence <= 2
            ? 'low'
            : capture.self_confidence >= 4
              ? 'high'
              : 'medium',
      ...capture,
      points,
    }),
  );
  return {
    forgettingInput,
    forgettingSuppressed:
      scope.preserveScheduling ||
      (!selfReport && (verdict.verdict === 'unsupported' || help !== 'none')),
    forgettingEngine: selectedForgettingEngine(),
    kind: 'plan',
    groupId: input.evaluation.evaluation_group_id,
    submissionId: input.submission.submission_id,
    evaluationId: input.evaluation.evaluation_id,
    attempt: input.evaluation.attempt,
    occurrenceAt: input.inputScope?.occurrence_at ?? input.submission.submitted_at.toISOString(),
    evaluatedAt: input.evaluation.created_at.toISOString(),
    provenance,
    verdict: {
      verdict: verdict.verdict,
      reason: verdict.reason,
      points: verdict.points,
      normalized: verdict.normalized,
    },
    rating,
    ratingSource,
    scopeVersion: SETTLEMENT_SCOPE_VERSION,
    scopeKcIds,
    fsrsSubjects,
    kcObservations: observations,
    theta,
    judgeRoute,
    difficultyLabelStreamItemId: scope.difficultyLabelStreamItemId,
  };
}

function candidateSchedulingSuppressed(plan: SettlementPlan): boolean {
  if (plan.forgettingSuppressed) return true;
  const selfReport = plan.forgettingInput
    ? plan.forgettingInput.fact.source === 'self_report'
    : plan.ratingSource === 'user';
  return (
    !selfReport &&
    (plan.verdict.verdict === 'unsupported' ||
      plan.provenance.assisted ||
      (plan.forgettingInput !== undefined &&
        (plan.forgettingInput.fact.help !== 'none' ||
          (plan.forgettingInput.fact.hints_used ?? 0) > 0 ||
          (plan.forgettingInput.fact.final_hint_level ?? 0) > 0)))
  );
}

function schedulingSubjects(plan: SettlementPlan): FsrsSubject[] {
  if (selectedForgettingEngine() === 'fsrs') return plan.rating === null ? [] : plan.fsrsSubjects;
  if (candidateSchedulingSuppressed(plan)) return [];
  if (!plan.forgettingInput) return plan.rating === null ? [] : plan.fsrsSubjects;
  const included = new Set(
    candidateObservations(plan.forgettingInput).flatMap((o) =>
      o.kind === 'included' ? [o.observation.skillId as string] : [],
    ),
  );
  return plan.fsrsSubjects.filter((subject) => included.has(subject.id));
}

function hasSchedulingEffect(plan: SettlementPlan): boolean {
  return schedulingSubjects(plan).length > 0;
}

function planSubjects(plan: SettlementPlan): Set<string> {
  const subjects = new Set<string>();
  if (hasSchedulingEffect(plan)) {
    for (const s of schedulingSubjects(plan)) subjects.add(subjectKey(s.kind, s.id));
  }
  if (plan.theta.applied) {
    for (const kc of plan.theta.knowledgeIds) subjects.add(subjectKey('knowledge', kc));
    for (const domain of Object.values(plan.theta.abilityGlobalByKnowledgeId)) {
      subjects.add(subjectKey('ability_global', domain));
    }
  }
  return subjects;
}

interface SettlementEventRow {
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

async function loadSettlementEvents(tx: Tx): Promise<SettlementEventRow[]> {
  const rows = await tx
    .select({ id: event.id, created_at: event.created_at, payload: event.payload })
    .from(event)
    .where(eq(event.action, ASSESSMENT_SETTLEMENT_ACTION));
  const out: SettlementEventRow[] = [];
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const effects = (p.effects ?? {}) as Record<string, unknown>;
    const subjects = new Set<string>(
      Array.isArray(effects.subjects)
        ? (effects.subjects as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
    );
    out.push({
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
    });
  }
  return out;
}

/** Live settlements plus user FSRS segments retained after their verdict was superseded. */
function liveAppliedSettlements(rows: SettlementEventRow[]): AppliedSettlementEvent[] {
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

/** Revert/re-apply order follows occurrence time then immutable submission ID. */
function byOccurrenceAsc(a: AppliedSettlementEvent, b: AppliedSettlementEvent): number {
  return (
    a.occurrenceMs - b.occurrenceMs ||
    (a.inputs.submissionId < b.inputs.submissionId
      ? -1
      : a.inputs.submissionId > b.inputs.submissionId
        ? 1
        : 0)
  );
}

/**
 * Seed is live settlements at or after the bound whose subjects intersect.
 * Each member's subjects pull in more settlements at that same bound.
 * The replaced settlement of this group stays out. The replaced channel handles it.
 */
function replayClosure(
  live: AppliedSettlementEvent[],
  input: {
    minOccurrenceMs: number;
    minSubmissionId?: string;
    excludeGroupId: string;
    seedSubjects: Set<string>;
  },
): AppliedSettlementEvent[] {
  const members = new Map<string, AppliedSettlementEvent>();
  const covered = new Set<string>(input.seedSubjects);
  const eligible = (m: AppliedSettlementEvent): boolean =>
    m.groupId !== input.excludeGroupId &&
    (m.occurrenceMs > input.minOccurrenceMs ||
      (m.occurrenceMs === input.minOccurrenceMs &&
        (!input.minSubmissionId || m.inputs.submissionId >= input.minSubmissionId)));
  const absorb = (m: AppliedSettlementEvent) => {
    if (members.has(m.id)) return;
    members.set(m.id, m);
    for (const s of m.subjects) covered.add(s);
  };
  for (const m of live) {
    if (!eligible(m)) continue;
    for (const s of m.subjects) {
      if (input.seedSubjects.has(s)) {
        absorb(m);
        break;
      }
    }
  }
  // Pull in every eligible member that touches a covered subject. The live set is finite.
  for (;;) {
    let grew = false;
    for (const m of live) {
      if (members.has(m.id) || !eligible(m)) continue;
      for (const s of m.subjects) {
        if (covered.has(s)) {
          absorb(m);
          grew = true;
          break;
        }
      }
    }
    if (!grew) return [...members.values()];
  }
}

interface ApplyOutcome {
  fsrsApplied: string[];
  thetaApplied: string[];
  /** A count-only family write still counts. It did not have to enter the mean. */
  familyObservationRecorded: boolean;
  /** The fold that was written. null never touched the calibration row. */
  familyFold: FamilyFoldRecord | null;
  subjects: Set<string>;
}

async function candidateHistory(
  tx: Tx,
  subject: FsrsSubject,
  current: SettlementPlan | null,
  cutoff: Date,
  resolvedPlans?: SettlementPlan[],
  historySubjectIds: string[] = [],
): Promise<SealedCandidateInput[]> {
  const live = liveAppliedSettlements(await loadSettlementEvents(tx));
  const plans = resolvedPlans
    ? [...resolvedPlans].filter(
        (p) => p.submissionId !== current?.submissionId && new Date(p.occurrenceAt) <= cutoff,
      )
    : live
        .filter(
          (m) =>
            [subject.id, ...historySubjectIds].some((id) =>
              m.fsrsApplied.includes(subjectKey(subject.kind, id)),
            ) &&
            m.inputs.submissionId !== current?.submissionId &&
            m.occurrenceMs <= cutoff.getTime(),
        )
        .map((m) => m.inputs);
  if (current) plans.push(current);
  const facts: SealedCandidateInput[] = [];
  for (const plan of plans) {
    if (candidateSchedulingSuppressed(plan)) continue;
    if (plan.forgettingInput) {
      facts.push(validateCandidateInput(plan.forgettingInput));
      continue;
    }
    const [sub] = await tx
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.submission_id, plan.submissionId));
    const [evalRow] = await tx
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, plan.evaluationId));
    if (!sub || !evalRow) throw new Error('sealed attempt history unavailable');
    const [issuance] = await tx
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, sub.issuance_id));
    const [head] = await tx
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, plan.groupId));
    const [revision] = await tx
      .select({ group_id: question_revision.group_id })
      .from(question_revision)
      .where(eq(question_revision.revision_id, sub.revision_id));
    if (!issuance || !head || !revision) throw new Error('sealed attempt coordinates unavailable');
    const frozenInput = EvaluationProvenance.parse(evalRow.provenance).input_snapshot;
    const input: ActivationSettleInput = {
      tx,
      submission: sub,
      evaluation: evalRow,
      issuance,
      head,
      questionGroupId: revision.group_id,
      inputScope: {
        issued_part_ids: frozenInput?.issued_part_ids ?? issuance.part_ids,
        occurrence_at: plan.occurrenceAt,
        member_submission_ids: frozenInput?.member_submission_ids ?? [sub.submission_id],
      },
      now: new Date(plan.occurrenceAt),
      ...(plan.ratingSource === 'user' && plan.rating ? { userRating: plan.rating } : {}),
    };
    const scope = await loadScope(tx, input);
    const rebuilt = derivePlan(input, scope);
    if (current && plan === current) {
      current.forgettingSuppressed = rebuilt.forgettingSuppressed;
    }
    if (rebuilt.forgettingSuppressed) continue;
    if (!rebuilt.forgettingInput) throw new Error('sealed candidate inputs unavailable');
    // Old settlements sealed their scheduling subjects even when no part/KC capture exists.
    // Use that frozen group scope, never today's mutable question labels or context.
    const historicalInput = scope.frozenLearningScope
      ? rebuilt.forgettingInput
      : sealCandidateFact({
          ...rebuilt.forgettingInput.fact,
          context: null,
          legacyScopeVersion: plan.scopeVersion,
          points: rebuilt.forgettingInput.fact.points.map((p) => ({
            ...p,
            shares:
              p.shares.length === 0 ||
              (rebuilt.forgettingInput?.fact.source === 'judged' &&
                plan.fsrsSubjects.length > 1 &&
                p.earned > 0 &&
                p.earned < p.maximum)
                ? []
                : plan.fsrsSubjects.map((s) => ({
                    skillId: s.id,
                    share: 1 / plan.fsrsSubjects.length,
                  })),
          })),
        });
    facts.push(historicalInput);
    if (current && plan === current) current.forgettingInput = historicalInput;
  }
  return facts.map((input) => {
    if (!input.fact.points.some((p) => p.shares.some((s) => historySubjectIds.includes(s.skillId))))
      return input;
    return sealCandidateFact({
      ...input.fact,
      identityRemap: { fromIds: historySubjectIds, toId: subject.id },
      points: candidatePointsForAdmission(input.fact).map((p) => ({
        ...p,
        shares: p.shares.map((s) => ({
          ...s,
          skillId: historySubjectIds.includes(s.skillId) ? subject.id : s.skillId,
        })),
      })),
    });
  });
}

/** Read-only legacy conversion. Historical receipts and the stored projection are never rewritten. */
export async function candidateStateForRead(tx: Tx, subject: FsrsSubject, now: Date) {
  const history = await candidateHistory(tx, subject, null, now);
  if (history.length === 0)
    return { ...initialCandidateState(subject.id, now), conversion: 'legacy_cold' as const };
  const last = new Date(Math.max(...history.map((f) => f.fact.occurredAt.getTime())));
  return rebuildCandidate(subject.id, history, last, 'legacy_history');
}

/**
 * Apply one plan from its sealed inputs. Do not re-judge.
 * FSRS, then one shared theta update, then brackets, then calibration.
 * Family calibration folds only when the score is objective and theta was applied.
 */
export interface SettlementObservers {
  /** Runs once for the new occurrence at its own ordered position, never for replayed neighbors. */
  onThetaApplied?: (tx: Tx, input: { knowledgeIds: string[]; outcome: 0 | 1 }) => Promise<void>;
}

async function executePlan(
  tx: Tx,
  plan: SettlementPlan,
  settlementEventId: string,
  occurrenceAt: Date,
  options: { skipFsrs?: boolean; memoryHistory?: SettlementPlan[] } & SettlementObservers = {},
): Promise<ApplyOutcome> {
  if (selectedForgettingEngine() === 'forgetting_candidate') {
    plan.forgettingReplayInputs = [];
    // Resolve old plans before selecting writers: excluded legacy facts cannot create cold rows.
    if (!plan.forgettingInput && !candidateSchedulingSuppressed(plan) && plan.fsrsSubjects[0]) {
      await candidateHistory(tx, plan.fsrsSubjects[0], plan, occurrenceAt, []);
    }
    plan.forgettingExcludedEvidence = plan.forgettingInput
      ? candidateObservations(plan.forgettingInput).filter(
          (observation) => observation.kind === 'excluded',
        )
      : [];
  }
  const outcome: ApplyOutcome = {
    fsrsApplied: [],
    thetaApplied: [],
    familyObservationRecorded: false,
    familyFold: null,
    subjects: planSubjects(plan),
  };

  // Single memory projection: legacy ratings or sealed candidate evidence, never both.
  const fsrsSnapshots: Array<{
    subject_kind: 'question' | 'knowledge';
    subject_id: string;
    before: SchedulingState | null;
    after: SchedulingState;
  }> = [];
  if (hasSchedulingEffect(plan) && !options.skipFsrs) {
    // Sorted fsrs subject locks, same namespace as updateThetaForAttempt. G is already held.
    const subjects = schedulingSubjects(plan);
    const keys = subjects.map((s) => subjectKey(s.kind, s.id)).sort();
    for (const key of keys) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:${key}`}))`);
    }
    for (const subject of subjects) {
      const source = await getFsrsState(tx, subject.kind, subject.id);
      const before = source?.state ?? null;
      const engine = selectedForgettingEngine();
      plan.forgettingEngine = engine;
      let after: SchedulingState;
      if (engine === 'forgetting_candidate') {
        const history = await candidateHistory(
          tx,
          subject,
          plan,
          occurrenceAt,
          options.memoryHistory?.filter((p) =>
            p.fsrsSubjects.some(
              (s) =>
                s.kind === subject.kind &&
                (s.id === subject.id ||
                  (before && isCandidateState(before) && before.historySubjectIds.includes(s.id))),
            ),
          ),
          before && isCandidateState(before) ? before.historySubjectIds : [],
        );
        after = rebuildCandidate(
          subject.id,
          history,
          occurrenceAt,
          before === null
            ? 'native'
            : isCandidateState(before)
              ? candidateRetention(
                  before,
                  new Date(
                    Math.max(
                      occurrenceAt.getTime(),
                      before.last_review?.getTime() ?? occurrenceAt.getTime(),
                    ),
                  ),
                ).now.kind === 'unknown' && before.global.projection.kind === 'warm'
                ? 'invalid_rebuilt'
                : 'native'
              : history.length > 1
                ? 'legacy_history'
                : 'legacy_cold',
          before && isCandidateState(before) ? before.historySubjectIds : [],
          (input) =>
            plan.forgettingReplayInputs?.push({
              ...input,
              subject_kind: subject.kind,
              subject_id: subject.id,
            }),
        );
      } else {
        if (before && isCandidateState(before))
          throw new Error('candidate state cannot be reinterpreted as FSRS');
        if (plan.rating === null) throw new Error('FSRS rating missing');
        const scheduled = scheduleReview(before, plan.rating, occurrenceAt);
        after = {
          ...scheduled.nextState,
          last_review: scheduled.nextState.last_review ?? null,
          engine: 'fsrs',
          schemaVersion: 'scheduling-state-v1',
        };
      }
      fsrsSnapshots.push({
        subject_kind: subject.kind,
        subject_id: subject.id,
        before,
        after,
      });
      await upsertFsrsState(tx, {
        subject_kind: subject.kind,
        subject_id: subject.id,
        state: after,
        due_at: after.due,
        last_review_event_id: settlementEventId,
      });
      outcome.fsrsApplied.push(subjectKey(subject.kind, subject.id));
    }
  }

  const thetaSnapshots: Awaited<ReturnType<typeof updateThetaForAttempt>>['theta_snapshots'] = [];
  let thetaBefore = 0;
  if (plan.theta.applied) {
    const theta = plan.theta;
    const familyPrimary = theta.familyPrimaryKnowledgeId ?? theta.knowledgeIds[0] ?? null;
    thetaBefore =
      familyPrimary !== null ? ((await getMasteryState(tx, familyPrimary))?.theta_hat ?? 0) : 0;
    const result = await updateThetaForAttempt(tx, {
      knowledgeIds: theta.knowledgeIds,
      questionId: theta.anchorQuestionId,
      outcome: theta.outcome,
      difficulty: theta.anchorDifficulty,
      attemptEventId: settlementEventId,
      now: occurrenceAt,
      kind: theta.anchorKind,
      source: theta.anchorSource,
      familyPrimaryKnowledgeId: familyPrimary,
      abilityGlobalByKnowledgeId: theta.abilityGlobalByKnowledgeId,
    });
    thetaSnapshots.push(...result.theta_snapshots);
    outcome.thetaApplied = [...theta.knowledgeIds];
  }

  await writeAttemptSnapshotBrackets(tx, {
    attemptEventId: settlementEventId,
    sessionId: null,
    now: occurrenceAt,
    thetaSnapshots,
    fsrsSnapshots,
  });

  if (plan.theta.applied) {
    const theta = plan.theta;
    try {
      await tx.transaction(async (sp) => {
        outcome.familyFold = await recordFamilyObservationForAttempt(sp, {
          primaryKnowledgeId: theta.familyPrimaryKnowledgeId ?? theta.knowledgeIds[0] ?? null,
          questionId: theta.anchorQuestionId,
          kind: theta.anchorKind,
          source: theta.anchorSource,
          difficulty: theta.anchorDifficulty,
          outcome: theta.outcome,
          attemptOutcome: theta.outcome === 1 ? 'success' : 'failure',
          judgeRoute: plan.judgeRoute,
          thetaBefore,
          now: occurrenceAt,
        });
      });
      // A receipt means the row was written. A count-only write did not enter the mean.
      // Revert uses record.folded to decide whether the mean comes back.
      outcome.familyObservationRecorded = outcome.familyFold !== null;
    } catch (err) {
      console.warn(
        '[assessment-settle] recordFamilyObservationForAttempt failed (non-fatal):',
        err,
      );
    }
  }
  if (plan.theta.applied) {
    const theta = plan.theta;
    try {
      await tx.transaction(async (sp) => {
        await recordDifficultyCalibrationLabel(sp, {
          questionId: theta.anchorQuestionId,
          attemptEventId: settlementEventId,
          difficulty: theta.anchorDifficulty,
          outcome: theta.outcome,
          attemptOutcome: theta.outcome === 1 ? 'success' : 'failure',
          judgeRoute: plan.judgeRoute,
          thetaBefore,
          now: occurrenceAt,
          streamItemId: plan.difficultyLabelStreamItemId,
        });
      });
    } catch (error) {
      console.warn('[assessment-settle] difficulty calibration label failed (non-fatal):', error);
    }
    await options.onThetaApplied?.(tx, {
      knowledgeIds: plan.theta.knowledgeIds,
      outcome: plan.theta.outcome,
    });
  }
  return outcome;
}

/** Undo one live member. A failed undo is ReplayRequired, not a partial revert. */
async function revertSettlementMember(
  tx: Tx,
  member: AppliedSettlementEvent,
  options: { skipFsrsSegment?: boolean } = {},
): Promise<ReplayRequired | null> {
  // The sealed residual is enough to un-fold. Order does not matter for this mean.
  // drift means the record says it folded while calibrated_n is 0. Something else wrote. Fail closed.
  if (member.familyObservationRecorded) {
    if (member.familyFold === null) {
      return { kind: 'family_fold_missing', settlementEventId: member.id };
    }
    const un = await unfoldFamilyCalibration(tx, { record: member.familyFold, now: new Date() });
    if (un === 'drift') {
      return { kind: 'family_fold_drift', settlementEventId: member.id };
    }
  }
  const segments: Array<'theta' | 'fsrs'> = member.fsrsOnly
    ? ['fsrs']
    : options.skipFsrsSegment
      ? ['theta']
      : ['theta', 'fsrs'];
  for (const segment of segments) {
    const checkpointId = `${member.id}:checkpoint:${segment}`;
    const result = await orchestrateCascadeRevert(tx, checkpointId, {
      reasonContext: { note: `assessment settlement replay (revert ${member.id})` },
    });
    if (!result.ok) {
      if (result.refusal === 'no_checkpoint') {
        // No bracket means this segment never moved. Continue with the other segment.
        continue;
      }
      return {
        kind: 'revert_failed',
        settlementEventId: member.id,
        refusal: `${result.refusal}: ${result.reason}`,
      };
    }
  }
  // Drop this member's difficulty label. Reapply mints a new event id, so the old label would double.
  // Falling under the minimum does not clear b_calib by itself. Clear it here,
  // or the undone attempt keeps feeding effectiveB.
  if (member.fsrsOnly) return null;
  const removedLabels = await tx
    .delete(difficulty_calibration_label)
    .where(eq(difficulty_calibration_label.attempt_event_id, member.id))
    .returning({ question_id: difficulty_calibration_label.question_id });
  for (const { question_id: questionId } of removedLabels) {
    try {
      await clearCalibrationBelowThreshold(tx, questionId);
    } catch (err) {
      console.warn(
        `[assessment-settle] clearCalibrationBelowThreshold failed for ${questionId} (non-fatal):`,
        err,
      );
    }
  }
  return null;
}

/** Persist both the replaced side and the effective side. A consumer must not infer either. */
async function writeSettlementEvent(
  tx: Tx,
  input: {
    id: string;
    plan: SettlementPlan | null;
    effect: 'applied' | 'ineligible' | 'replay_required' | 'withdrawn';
    activatedAt: Date;
    occurrenceAt: Date | null;
    groupId: string;
    submissionId: string;
    evaluationId: string | null;
    priorEffectiveEvaluationId: string | null;
    supersedesSettlementEventId: string | null;
    replayOf: string | null;
    revertedIds: string[];
    appliedOutcome: ApplyOutcome | null;
    reasonDetail?: Record<string, unknown>;
    fsrsOnly?: boolean;
  },
): Promise<void> {
  const plan = input.plan;
  await writeEvent(tx, {
    id: input.id,
    session_id: null,
    actor_kind: 'system',
    actor_ref: 'assessment_settlement',
    action: ASSESSMENT_SETTLEMENT_ACTION,
    subject_kind: 'evaluation_group',
    subject_id: input.groupId,
    outcome: input.effect === 'applied' ? 'success' : null,
    payload: {
      version: ASSESSMENT_SETTLEMENT_VERSION,
      evaluation_id: input.evaluationId,
      evaluation_group_id: input.groupId,
      submission_id: input.submissionId,
      attempt: plan?.attempt ?? null,
      effect: input.effect,
      occurrence_at: input.occurrenceAt?.toISOString() ?? null,
      evaluated_at: plan?.evaluatedAt ?? null,
      activated_at: input.activatedAt.toISOString(),
      supersedes_evaluation_id: input.priorEffectiveEvaluationId,
      supersedes_settlement_event_id: input.supersedesSettlementEventId,
      replay_of: input.replayOf,
      reverted_settlement_event_ids: input.revertedIds,
      scope_version: plan?.scopeVersion ?? null,
      verdict: plan?.verdict ?? null,
      rating: plan?.rating ?? null,
      rating_source: plan?.ratingSource ?? null,
      provenance: plan?.provenance ?? null,
      kc_observations: plan?.kcObservations ?? [],
      theta_decision: plan?.theta ?? null,
      effects: input.appliedOutcome
        ? {
            subjects: [...input.appliedOutcome.subjects].sort(),
            fsrs_applied: input.appliedOutcome.fsrsApplied,
            theta_applied: input.appliedOutcome.thetaApplied,
            family_observation_recorded: input.appliedOutcome.familyObservationRecorded,
            family_fold: input.appliedOutcome.familyFold,
          }
        : {
            subjects: [],
            fsrs_applied: [],
            theta_applied: [],
            family_observation_recorded: false,
            family_fold: null,
          },
      // Subjects this settlement will touch. replay_required still names the conflict domain.
      // An empty set would hide the work from the replay consumer.
      planned_subjects: plan ? [...planSubjects(plan)].sort() : [],
      replay_inputs: plan ?? null,
      ...(input.fsrsOnly ? { fsrs_only: true } : {}),
      ...(input.reasonDetail ?? {}),
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    ingest_at: input.activatedAt,
    created_at: input.activatedAt,
  });
}

/**
 * Call only from activateEvaluation, inside the transaction that already holds G.
 * This function opens no top-level transaction. Replay is a nested savepoint.
 */
export async function learningSettlement(
  input: ActivationSettleInput,
  observers: SettlementObservers = {},
): Promise<ActivationEffect> {
  const { tx } = input;
  const activatedAt = input.now;

  const scope = await loadScope(tx, input);
  const plan = derivePlan(input, scope);
  // The validated plan owns the joint occurrence. Its anchor may have been
  // submitted earlier; actual writes, receipts and replay boundaries must agree.
  const occurrenceAt = new Date(plan.occurrenceAt);
  const occurrenceMs = occurrenceAt.getTime();
  // Freeze whether hierarchical elo was on. Reapply must not resolve it again.
  if (plan.theta.applied) {
    plan.theta.abilityGlobalByKnowledgeId =
      scope.frozenAbilityGlobalByKnowledgeId === undefined
        ? await resolveAbilityGlobalByKnowledgeId(tx, plan.theta.knowledgeIds)
        : Object.fromEntries(
            Object.entries(scope.frozenAbilityGlobalByKnowledgeId).filter(
              ([kc]) => plan.theta.applied && plan.theta.knowledgeIds.includes(kc),
            ),
          );
  }
  const mySubjects = planSubjects(plan);
  const settlementEventId = `stl_${createId()}`;
  for (const subject of schedulingSubjects(plan)) {
    const [row] = await tx
      .select({ state: material_fsrs_state.state })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, subject.kind),
          eq(material_fsrs_state.subject_id, subject.id),
        ),
      );
    if (row && !SchedulingStateSchema.safeParse(row.state).success) {
      await writeReplayRequired(tx, {
        eventId: settlementEventId,
        plan,
        activatedAt,
        priorEffectiveEvaluationId: input.head.effective_evaluation_id,
        detail: {
          kind: 'invalid_scheduling_state',
          subject: subjectKey(subject.kind, subject.id),
          reason: 'no_valid_restore_bracket',
        },
      });
      return 'failed_pending';
    }
  }

  const rows = await loadSettlementEvents(tx);
  const live = liveAppliedSettlements(rows);
  const priorEffectiveId = input.head.effective_evaluation_id;
  const replaced: AppliedSettlementEvent[] = priorEffectiveId
    ? live.filter(
        (m) => !m.fsrsOnly && m.groupId === plan.groupId && m.evaluationId === priorEffectiveId,
      )
    : [];
  if (replaced.length > 1) {
    // More than one live applied settlement for one effective evaluation is inconsistent.
    // CAS should have stopped the second write. Do not pick an authority.
    await writeReplayRequired(tx, {
      eventId: settlementEventId,
      plan,
      activatedAt,
      priorEffectiveEvaluationId: priorEffectiveId,
      detail: {
        kind: 'ambiguous_prior_settlement',
        settlement_event_ids: replaced.map((m) => m.id),
      },
    });
    return 'failed_pending';
  }
  const replacedMember = replaced[0] ?? null;
  // A scheduling choice belongs to this occurrence. Preserve it across its
  // regrades even after later occurrences have advanced the shared card; those
  // later occurrences are reverted/replayed below from their own frozen plans.
  const fsrsAtRisk = new Set<string>();
  if (hasSchedulingEffect(plan)) {
    for (const s of schedulingSubjects(plan)) fsrsAtRisk.add(subjectKey(s.kind, s.id));
  }
  if (replacedMember !== null) {
    for (const s of replacedMember.fsrsApplied) fsrsAtRisk.add(s);
  }
  const occurrenceHasUserRating = preservedUserRatingExists(rows, [...fsrsAtRisk], plan.groupId);
  // A user rating stays until another user rating replaces it.
  // This call's user rating replaces it. A verdict rating leaves the user schedule in place.
  const preserveUserRating =
    (plan.ratingSource !== 'user' || input.reusesActivation === true) && occurrenceHasUserRating;

  // Seed is this settlement's subjects plus the replaced settlement's subjects.
  // A full regrade can have no subjects of its own, and the replaced writes still have to revert.
  // Leave them out and a later other-group settlement on those subjects never enters the closure.
  // Reverting the old snapshot then hits that chain and fails closed.
  const seedSubjects = new Set<string>(mySubjects);
  if (replacedMember !== null) {
    for (const s of replacedMember.subjects) seedSubjects.add(s);
  }
  const conflictSet = replayClosure(live, {
    minOccurrenceMs: occurrenceMs,
    minSubmissionId: plan.submissionId,
    excludeGroupId: plan.groupId,
    seedSubjects,
  });

  const revertSet = [...conflictSet];
  if (replacedMember !== null) revertSet.push(replacedMember);
  const reapplySet = conflictSet.slice().sort(byOccurrenceAsc);
  const revertOrder = revertSet.slice().sort(byOccurrenceAsc).reverse();

  // A later trace from a non-settlement writer is replay_required.
  // Check this before the fast path. A first settlement can still land on a hand-written or legacy review,
  // and appending would hide that out-of-order evidence.
  const unexplained = await findUnattributedNewerWrites(tx, {
    occurrenceMs,
    fsrsSubjects: schedulingSubjects(plan),
    thetaKcIds: plan.theta.applied ? plan.theta.knowledgeIds : [],
    abilityIds: plan.theta.applied ? Object.values(plan.theta.abilityGlobalByKnowledgeId) : [],
    reapplySet,
    liveIds: new Set(live.map((m) => m.id)),
  });
  if (unexplained !== null) {
    await writeReplayRequired(tx, {
      eventId: settlementEventId,
      plan,
      activatedAt,
      priorEffectiveEvaluationId: priorEffectiveId,
      detail: unexplained,
    });
    return 'failed_pending';
  }

  if (revertSet.length === 0 && !preserveUserRating) {
    let applied: ApplyOutcome;
    try {
      applied =
        selectedForgettingEngine() === 'forgetting_candidate'
          ? await tx.transaction((sp) =>
              executePlan(sp, plan, settlementEventId, occurrenceAt, observers),
            )
          : await executePlan(tx, plan, settlementEventId, occurrenceAt, observers);
    } catch (error) {
      if (selectedForgettingEngine() !== 'forgetting_candidate') throw error;
      await writeReplayRequired(tx, {
        eventId: settlementEventId,
        plan,
        activatedAt,
        priorEffectiveEvaluationId: priorEffectiveId,
        detail: {
          kind: 'candidate_rebuild_failed',
          reason: error instanceof Error ? error.message : 'unknown_failure',
        },
      });
      return 'failed_pending';
    }
    const effect: ActivationEffect =
      applied.fsrsApplied.length > 0 || applied.thetaApplied.length > 0 ? 'applied' : 'ineligible';
    await writeSettlementEvent(tx, {
      id: settlementEventId,
      plan,
      effect: effect === 'applied' ? 'applied' : 'ineligible',
      activatedAt,
      occurrenceAt,
      groupId: plan.groupId,
      submissionId: plan.submissionId,
      evaluationId: plan.evaluationId,
      priorEffectiveEvaluationId: priorEffectiveId,
      supersedesSettlementEventId: null,
      replayOf: null,
      revertedIds: [],
      appliedOutcome: applied,
    });
    return effect;
  }

  // One savepoint. Revert newest to oldest, apply this settlement, then reapply oldest to newest.
  const replayAppliedIds = new Map<string, string>(); // old event id to the new event id
  let appliedOutcome: ApplyOutcome;
  try {
    appliedOutcome = await tx.transaction(async (sp): Promise<ApplyOutcome> => {
      for (const member of revertOrder) {
        const refusal = await revertSettlementMember(sp, member, {
          skipFsrsSegment: member.id === replacedMember?.id && preserveUserRating,
        });
        if (refusal !== null) {
          throw new ReplayRequiredError(refusal);
        }
      }
      const memoryHistory = live
        .filter(
          (m) =>
            m.fsrsApplied.length > 0 &&
            (!revertSet.some((reverted) => reverted.id === m.id) ||
              (m.id === replacedMember?.id && preserveUserRating)),
        )
        .map((m) => m.inputs);
      const mine = await executePlan(sp, plan, settlementEventId, occurrenceAt, {
        skipFsrs: preserveUserRating,
        memoryHistory,
        ...observers,
      });
      if (mine.fsrsApplied.length > 0) memoryHistory.push(plan);
      for (const member of reapplySet) {
        const newIdFor = `stl_${createId()}`;
        // A rating with an empty fsrs_applied list never wrote the card.
        // Replay must skip it too, or the kept user rating becomes the verdict rating.
        const memberSkippedFsrs =
          hasSchedulingEffect(member.inputs) && member.fsrsApplied.length === 0;
        const reOutcome = await executePlan(
          sp,
          member.inputs,
          newIdFor,
          new Date(member.occurrenceMs),
          { skipFsrs: memberSkippedFsrs, memoryHistory },
        );
        if (reOutcome.fsrsApplied.length > 0) memoryHistory.push(member.inputs);
        replayAppliedIds.set(member.id, newIdFor);
        await writeSettlementEvent(sp, {
          id: newIdFor,
          plan: member.inputs,
          effect: 'applied',
          activatedAt,
          occurrenceAt: new Date(member.occurrenceMs),
          groupId: member.groupId,
          submissionId: member.inputs.submissionId,
          evaluationId: member.evaluationId,
          // Reapply does not invent a supersede link. replay_of points at the original chain.
          priorEffectiveEvaluationId: null,
          supersedesSettlementEventId: null,
          replayOf: member.id,
          revertedIds: [member.id],
          appliedOutcome: reOutcome,
          fsrsOnly: member.fsrsOnly,
        });
      }
      return mine;
    });
  } catch (err) {
    const detail: Record<string, unknown> =
      err instanceof ReplayRequiredError
        ? (err.detail as unknown as Record<string, unknown>)
        : { kind: 'reapply_failed', reason: err instanceof Error ? err.message : String(err) };
    await writeReplayRequired(tx, {
      eventId: settlementEventId,
      plan,
      activatedAt,
      priorEffectiveEvaluationId: priorEffectiveId,
      detail,
    });
    return 'failed_pending';
  }

  await writeSettlementEvent(tx, {
    id: settlementEventId,
    plan,
    effect: 'applied',
    activatedAt,
    occurrenceAt,
    groupId: plan.groupId,
    submissionId: plan.submissionId,
    evaluationId: plan.evaluationId,
    priorEffectiveEvaluationId: priorEffectiveId,
    supersedesSettlementEventId: replacedMember?.id ?? null,
    replayOf: null,
    revertedIds: revertOrder.map((m) => m.id),
    appliedOutcome,
  });
  return 'applied';
}

class ReplayRequiredError extends Error {
  constructor(public readonly detail: ReplayRequired) {
    super(`assessment settlement replay required: ${detail.kind}`);
    this.name = 'ReplayRequiredError';
  }
}

async function writeReplayRequired(
  tx: Tx,
  input: {
    eventId: string;
    plan: SettlementPlan | null;
    activatedAt: Date;
    priorEffectiveEvaluationId: string | null;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await writeSettlementEvent(tx, {
    id: input.eventId,
    plan: input.plan,
    effect: 'replay_required',
    activatedAt: input.activatedAt,
    occurrenceAt: input.plan ? new Date(input.plan.occurrenceAt) : null,
    groupId: input.plan?.groupId ?? 'unknown',
    submissionId: input.plan?.submissionId ?? 'unknown',
    evaluationId: input.plan?.evaluationId ?? 'unknown',
    priorEffectiveEvaluationId: input.priorEffectiveEvaluationId,
    supersedesSettlementEventId: null,
    replayOf: null,
    revertedIds: [],
    appliedOutcome: null,
    reasonDetail: { replay_required: input.detail },
  });
}

/** User FSRS writes remain the scheduling authority for their own occurrence.
 * A later correction can supersede the event without undoing its FSRS segment,
 * so both live and preserved historical receipts matter. Other groups never
 * qualify; their schedules continue normally and are replayed in occurrence order. */
function preservedUserRatingExists(
  rows: SettlementEventRow[],
  subjectKeys: readonly string[],
  groupId: string,
): boolean {
  const wanted = new Set(subjectKeys);
  return rows.some(
    (row) =>
      row.groupId === groupId &&
      row.inputs?.ratingSource === 'user' &&
      row.fsrsApplied.some((key) => wanted.has(key)),
  );
}

/**
 * A trace after this occurrence, on a subject this settlement writes, must belong
 * to a closure member. Otherwise it cannot be replayed.
 */
async function findUnattributedNewerWrites(
  tx: Tx,
  input: {
    occurrenceMs: number;
    /** FSRS subjects this call will write. A null rating writes none, so skip the check. */
    fsrsSubjects: FsrsSubject[];
    /** Theta KCs this call will write. Abstain writes none. */
    thetaKcIds: string[];
    /** ability_global domain, only when theta was applied and hierarchical elo is on. */
    abilityIds: string[];
    reapplySet: AppliedSettlementEvent[];
    liveIds: Set<string>;
  },
): Promise<Record<string, unknown> | null> {
  const fsrsWanted = new Map<string, 'knowledge' | 'question'>();
  for (const s of input.fsrsSubjects) fsrsWanted.set(s.id, s.kind);

  const memberBySubjectAndOcc = new Map<string, AppliedSettlementEvent>();
  for (const m of input.reapplySet) {
    for (const s of m.subjects) memberBySubjectAndOcc.set(`${s}@${m.occurrenceMs}`, m);
  }

  if (fsrsWanted.size > 0) {
    const rows = await tx
      .select({
        subject_kind: material_fsrs_state.subject_kind,
        subject_id: material_fsrs_state.subject_id,
        state: material_fsrs_state.state,
        last_review_event_id: material_fsrs_state.last_review_event_id,
      })
      .from(material_fsrs_state)
      .where(
        and(
          inArray(material_fsrs_state.subject_kind, ['knowledge', 'question']),
          inArray(material_fsrs_state.subject_id, [...fsrsWanted.keys()]),
        ),
      );
    for (const row of rows) {
      if (fsrsWanted.get(row.subject_id) !== row.subject_kind) continue;
      const key = subjectKey(row.subject_kind, row.subject_id);
      const lastReview = coerceMs(
        (row.state as { last_review?: Date | string | null } | null)?.last_review ?? null,
      );
      if (lastReview === null || lastReview <= input.occurrenceMs) continue;
      const writer = row.last_review_event_id;
      if (writer !== null && input.liveIds.has(writer)) {
        const member = input.reapplySet.find((m) => m.id === writer);
        if (member && member.occurrenceMs === lastReview) continue;
      }
      return {
        kind: 'unattributed_newer_write',
        subject: key,
        detail: `material_fsrs_state.last_review ${new Date(lastReview).toISOString()} by '${writer ?? 'unknown'}'`,
      };
    }
  }

  if (input.thetaKcIds.length > 0) {
    const rows = await tx
      .select({
        subject_id: mastery_state.subject_id,
        lastOutcomeAt: mastery_state.last_outcome_at,
      })
      .from(mastery_state)
      .where(
        and(
          eq(mastery_state.subject_kind, 'knowledge'),
          inArray(mastery_state.subject_id, input.thetaKcIds),
        ),
      );
    for (const row of rows) {
      const at = coerceMs(row.lastOutcomeAt);
      if (at === null || at <= input.occurrenceMs) continue;
      if (memberBySubjectAndOcc.has(`knowledge:${row.subject_id}@${at}`)) continue;
      return {
        kind: 'unattributed_newer_write',
        subject: `knowledge:${row.subject_id}`,
        detail: `mastery_state.last_outcome_at ${new Date(at).toISOString()}`,
      };
    }
  }
  if (input.abilityIds.length > 0) {
    const rows = await tx
      .select({
        subject_id: mastery_state.subject_id,
        lastOutcomeAt: mastery_state.last_outcome_at,
      })
      .from(mastery_state)
      .where(
        and(
          eq(mastery_state.subject_kind, 'ability_global'),
          inArray(mastery_state.subject_id, input.abilityIds),
        ),
      );
    for (const row of rows) {
      const at = coerceMs(row.lastOutcomeAt);
      if (at === null || at <= input.occurrenceMs) continue;
      if (memberBySubjectAndOcc.has(`ability_global:${row.subject_id}@${at}`)) continue;
      return {
        kind: 'unattributed_newer_write',
        subject: `ability_global:${row.subject_id}`,
        detail: `mastery_state(ability_global).last_outcome_at ${new Date(at).toISOString()}`,
      };
    }
  }
  return null;
}

/** Withdraw an ingestion occurrence atomically; immutable originals remain readable. */
export async function withdrawCapturedOccurrence(
  tx: Tx,
  input: {
    originalAttemptEventId: string;
    correctionEventId: string;
    blockId: string;
    sessionId: string;
    now: Date;
  },
): Promise<void> {
  await acquireLearningStateWriteLock(tx);
  const refuse = (detail: string): never => {
    throw new ApiError('capture_revert_conflict', detail, 409);
  };
  const [original] = await tx
    .select()
    .from(event)
    .where(eq(event.id, input.originalAttemptEventId));
  if (
    original?.action !== 'experimental:assessment_attempt' ||
    original.payload.entry !== 'ingestion_grading'
  )
    return refuse('original is not a native ingestion capture');
  const groupId = original.payload.evaluation_group_id;
  const submissionId = original.payload.submission_id;
  if (typeof groupId !== 'string' || typeof submissionId !== 'string')
    return refuse('capture coordinates missing');
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('assessment-evaluation-group'), hashtext(${groupId}))`,
  );
  const [submission] = await tx
    .select()
    .from(assessment_submission)
    .where(eq(assessment_submission.submission_id, submissionId))
    .for('update');
  const [head] = await tx
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, groupId))
    .for('update');
  if (!submission || submission.evaluation_group_id !== groupId || !head)
    return refuse('capture head missing');
  const [issuance] = await tx
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, submission.issuance_id));
  const [receipt] = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_issuance'),
        eq(event.subject_id, submission.issuance_id),
      ),
    );
  const source = receipt?.payload.capture_source;
  if (
    !issuance ||
    issuance.revision_id !== submission.revision_id ||
    receipt?.payload.mode !== 'capture_existing' ||
    receipt.payload.scheduling_policy !== 'preserve' ||
    !source ||
    typeof source !== 'object' ||
    !('block_id' in source) ||
    source.block_id !== input.blockId ||
    !('session_id' in source) ||
    source.session_id !== input.sessionId
  )
    return refuse('capture ownership mismatch');
  const rows = await loadSettlementEvents(tx);
  if (rows.some((row) => row.groupId === groupId && row.effect === 'withdrawn')) return;
  const dead = new Set(
    rows.flatMap((row) => [
      ...row.revertedIds,
      ...(row.replayOf ? [row.replayOf] : []),
      ...(row.supersedesSettlementEventId ? [row.supersedesSettlementEventId] : []),
    ]),
  );
  if (
    rows.some(
      (row) =>
        row.groupId === groupId && row.effect === 'applied' && !dead.has(row.id) && !row.inputs,
    )
  )
    return refuse('capture settlement has no replay inputs');
  const live = liveAppliedSettlements(rows);
  const targets = live.filter((row) => row.groupId === groupId);
  if (
    targets.length > 1 ||
    targets.some((row) => row.fsrsOnly || row.fsrsApplied.length > 0 || row.inputs.rating !== null)
  )
    return refuse('capture has ambiguous or unexpected scheduling effects');
  const target = targets[0];
  const closure = target
    ? replayClosure(live, {
        minOccurrenceMs: target.occurrenceMs,
        excludeGroupId: groupId,
        seedSubjects: target.subjects,
      })
    : [];
  if (target) {
    const plan = target.inputs;
    const unexplained = await findUnattributedNewerWrites(tx, {
      occurrenceMs: target.occurrenceMs,
      fsrsSubjects: [],
      thetaKcIds: plan.theta.applied ? plan.theta.knowledgeIds : [],
      abilityIds: plan.theta.applied ? Object.values(plan.theta.abilityGlobalByKnowledgeId) : [],
      reapplySet: closure,
      liveIds: new Set(live.map((row) => row.id)),
    });
    if (unexplained) return refuse(`unsafe capture reversal: ${unexplained.kind}`);
  }
  const revertOrder = [...closure, ...targets].sort(byOccurrenceAsc).reverse();
  for (const member of revertOrder) {
    const refusal = await revertSettlementMember(tx, member, { skipFsrsSegment: false });
    if (refusal) return refuse(`capture reversal refused: ${refusal.kind}`);
  }
  for (const member of closure.sort(byOccurrenceAsc)) {
    const id = `stl_${createId()}`;
    const appliedOutcome = await executePlan(tx, member.inputs, id, new Date(member.occurrenceMs), {
      skipFsrs: hasSchedulingEffect(member.inputs) && member.fsrsApplied.length === 0,
    });
    await writeSettlementEvent(tx, {
      id,
      plan: member.inputs,
      effect: 'applied',
      activatedAt: input.now,
      occurrenceAt: new Date(member.occurrenceMs),
      groupId: member.groupId,
      submissionId: member.inputs.submissionId,
      evaluationId: member.evaluationId,
      priorEffectiveEvaluationId: null,
      supersedesSettlementEventId: null,
      replayOf: member.id,
      revertedIds: [member.id],
      appliedOutcome,
      fsrsOnly: member.fsrsOnly,
    });
  }
  await writeSettlementEvent(tx, {
    id: `stl_withdraw_${input.correctionEventId}`,
    plan: null,
    effect: 'withdrawn',
    activatedAt: input.now,
    occurrenceAt: submission.submitted_at,
    groupId,
    submissionId,
    evaluationId: head.effective_evaluation_id,
    priorEffectiveEvaluationId: head.effective_evaluation_id,
    supersedesSettlementEventId: null,
    replayOf: null,
    revertedIds: revertOrder.map((row) => row.id),
    appliedOutcome: null,
    reasonDetail: {
      correction_event_id: input.correctionEventId,
      issuance_id: submission.issuance_id,
      previous_generation: head.generation,
      generation: head.generation + 1,
    },
  });
  await tx
    .update(evaluation_effective_head)
    .set({ effective_evaluation_id: null, generation: head.generation + 1, updated_at: input.now })
    .where(eq(evaluation_effective_head.evaluation_group_id, groupId));
}
