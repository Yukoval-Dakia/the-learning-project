// What one activation means for settlement: load the sealed scope, derive the
// single plan (subjects, observations, theta/calibration decision, forgetting
// fact), and project the subjects and scheduling effect that plan owns. The
// write path consumes these facts; this module never writes.

import { and, eq, inArray } from 'drizzle-orm';

import { SYNTHETIC_SUBJECT_ROOT_RE } from '@/capabilities/practice/public';
import { canonicalHash } from '@/core/migration/canonical';
import type { ExecutionPlanT, ResponseSpecT, ScoringBasisT } from '@/core/schema/assessment';
import {
  EvaluationProvenance,
  SETTLEMENT_SCOPE_VERSION,
  deriveCoarseVerdict,
  localizeKcObservations,
  projectIssuedScoringBasis,
  ratingForVerdict,
  resolveThetaDecision,
} from '@/core/schema/assessment';
import type { Tx } from '@/db/client';
import { event, question, question_revision } from '@/db/schema';
import { getNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import type { AbilityGlobalByKnowledgeId } from '@/kernel/read-models/mastery-state';
import {
  CandidateFactSchema,
  candidateObservations,
  sealCandidateFact,
} from '@/server/fsrs/candidate';
import { selectedForgettingEngine } from '@/server/fsrs/engine-selection';
import type { ActivationSettleInput } from './activate';
import { loadAssessmentLearningScope } from './learning-scope';
import {
  type CalibrationEvidencePlan,
  type FsrsSubject,
  type RederiveSettlementPlan,
  type SettlementPlan,
  candidateSchedulingSuppressed,
  subjectKey,
} from './settle-read';

interface QuestionLite {
  id: string;
  knowledge_ids: string[];
  difficulty: number;
  kind: string;
  source: string;
}

function normalizeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
}

function contentKcs(ids: readonly string[]): string[] {
  return normalizeIds(ids).filter((id) => !SYNTHETIC_SUBJECT_ROOT_RE.test(id));
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

export async function loadScope(tx: Tx, input: ActivationSettleInput): Promise<SettlementScope> {
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
  // YUK-1600 — goal/container nodes are not testable KCs: strip them from the question
  // labels BEFORE the plan is derived, so θ anchors, FSRS subjects, KC observations and
  // score shares all exclude non-kc ids in one place. A question labeled only with
  // non-kc nodes degrades to the existing roots-only behavior (question-level FSRS
  // fallback / theta abstain), never to a mastery write on a goal root.
  const nonKcIds = await getNonKcKnowledgeIds(
    tx,
    [...byId.values()].flatMap((r) => r.knowledge_ids ?? []),
  );
  if (nonKcIds.size > 0) {
    for (const [rowId, row] of byId) {
      if (row.knowledge_ids.some((id) => nonKcIds.has(id))) {
        byId.set(rowId, {
          ...row,
          knowledge_ids: row.knowledge_ids.filter((id) => !nonKcIds.has(id)),
        });
      }
    }
  }
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

export function derivePlan(input: ActivationSettleInput, scope: SettlementScope): SettlementPlan {
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

  // YUK-1604 — 讲解 vs 独立作答的去向分界：只有可证明独立的作答才更新掌握度。Submission
  // receipts always snapshot the issuance assistance (single writer submit.ts), so a
  // non-'independent' status means answer-help exposure or an unclassifiable one; the
  // graduated-hint counters are the same process evidence the forgetting engine reads.
  // Assisted attempts stay FULL evidence (assistance events, attempt, records, candidate
  // excluded observations) — they just never move θ̂/PFA or scheduling here.
  const independentAttempt =
    scope.assistance === 'independent' &&
    (scope.capture.hints_used ?? 0) === 0 &&
    (scope.capture.final_hint_level ?? 0) === 0;
  const learnerAssisted = !independentAttempt;
  const unitPartIds = unitPartIdsOf(scope.basis, scope.spec);
  const observations = localizeKcObservations(scope.basis, input.evaluation.unit_results, {
    unitPartIds,
    partKcIds,
    groupKcIds: scopeKcIds,
  });
  // YUK-1604 — the judge-side decision stays the calibration anchor input (unchanged);
  // the learner-assist gate below only withholds the θ̂/PFA update itself.
  const judgeThetaDecision = resolveThetaDecision(observations, provenance);
  const thetaDecision =
    judgeThetaDecision.kind === 'update' && learnerAssisted
      ? ({ kind: 'abstain', reason: 'learner_assisted' } as const)
      : judgeThetaDecision;

  // YUK-1604 — 独立作答才产生自动调度评级：看过讲解/带提示的作答是过程证据（与
  // candidate 引擎的 forgettingSuppressed 同型）；用户显式自评（userRating）不受影响。
  const autoRatingSuppressed =
    provenance.source === 'automatic' && (provenance.assisted || learnerAssisted);
  const rating = scope.preserveScheduling
    ? null
    : (input.userRating ?? (autoRatingSuppressed ? null : ratingForVerdict(verdict.verdict)));
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

  // YUK-439 — 标定证据的锚推导从 theta 分支**提出**：theta abstain（partial/mixed）
  // 不排除证据（A4 连续分数进标定）。锚规则与 theta 分支同一推导：单 part 覆盖 → 该
  // part 行；跨 part / 无 decided KC → group root。theta applied 路径的锚与下方的
  // theta.anchor 完全一致（同一 partsCovering 推导）。
  const calibrationEligible =
    provenance.source === 'automatic' && !provenance.assisted && verdict.normalized != null;
  const calibrationUpdateSet = new Set(
    judgeThetaDecision.kind === 'update' ? judgeThetaDecision.knowledgeIds : [],
  );
  const calibrationPartsCovering = new Set<string>();
  for (const [partId, kcs] of partKcIds) {
    if (kcs.some((kc) => calibrationUpdateSet.has(kc))) calibrationPartsCovering.add(partId);
  }
  const calibrationAnchor =
    calibrationPartsCovering.size === 1
      ? (scope.partRows.get([...calibrationPartsCovering][0]) ?? scope.groupRow)
      : scope.groupRow;
  const calibration: CalibrationEvidencePlan | null =
    calibrationEligible && calibrationAnchor
      ? {
          questionId: calibrationAnchor.id,
          difficulty: calibrationAnchor.difficulty,
          primaryKnowledgeId: calibrationAnchor.knowledge_ids[0] ?? null,
          containerRef: input.issuance.container_occurrence_ref ?? null,
        }
      : null;

  let theta: SettlementPlan['theta'];
  if (thetaDecision.kind === 'abstain') {
    theta = { applied: false, abstainReason: thetaDecision.reason };
  } else {
    // One part: that physical question row, because item calibration is keyed by row.
    // Across parts: the group root stands for the difficulty and family keys.
    // 〔YUK-439：原锚推导已上提为 calibrationAnchor（同一 partsCovering 规则，
    // updateSet 一致时同锚）；此处复用其结果，applied 路径行为逐位不变。〕
    const anchor = calibrationAnchor;
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
    calibration,
  };
}

export function schedulingSubjects(plan: SettlementPlan): FsrsSubject[] {
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

export function hasSchedulingEffect(plan: SettlementPlan): boolean {
  return schedulingSubjects(plan).length > 0;
}

export function planSubjects(plan: SettlementPlan): Set<string> {
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

/**
 * Scope loading and plan derivation stay writer-internal. History assembly in
 * settle-read reaches them only through this bound port, so the read module
 * keeps no edge back to the settlement writer.
 */
export const rederiveSettlementPlan: RederiveSettlementPlan = async (tx, input) => {
  const scope = await loadScope(tx, input);
  return { plan: derivePlan(input, scope), frozenLearningScope: scope.frozenLearningScope };
};
