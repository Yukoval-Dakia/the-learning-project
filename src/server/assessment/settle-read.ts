// Read side of the assessment settlement ledger.
// Owns the sealed event-row decode, the live-applied projection, the replay
// closure fixpoint, occurrence ordering, and forgetting-candidate history
// assembly. The write path (learningSettlement, revert/replay, withdraw) stays
// in settle.ts and consumes these projections; this module writes nothing.
// Plans recorded before sealed forgetting inputs existed are re-derived through
// the caller-bound RederiveSettlementPlan port — scope loading and plan
// derivation remain settle.ts internals, so there is no settle.ts import edge.

import { eq } from 'drizzle-orm';

import { settlementReversions } from '@/core/assessment-settlement-liveness';
import type { KcObservation } from '@/core/schema/assessment';
import { EvaluationProvenance } from '@/core/schema/assessment';
import type { Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  question_revision,
} from '@/db/schema';
import {
  type CandidateReplayInput,
  type SealedCandidateInput,
  type candidateObservations,
  candidatePointsForAdmission,
  initialCandidateState,
  rebuildCandidate,
  sealCandidateFact,
  validateCandidateInput,
} from '@/server/fsrs/candidate';
import type { FamilyFoldRecord } from '@/server/mastery/personalized-difficulty';
import type { AbilityGlobalByKnowledgeId } from '@/server/mastery/state';
import type { ActivationSettleInput } from './activate';

// The settlement event action this ledger reads. Mirrors
// ASSESSMENT_SETTLEMENT_ACTION in settle.ts, which stays the writer-facing
// export; a literal here keeps this module free of a settle.ts edge (same
// pattern as src/kernel/read-models/assessment-verdict.ts).
const ASSESSMENT_SETTLEMENT_ACTION = 'experimental:assessment_settlement';

export interface FsrsSubject {
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

export function candidateSchedulingSuppressed(plan: SettlementPlan): boolean {
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

export async function loadSettlementEvents(tx: Tx): Promise<SettlementEventRow[]> {
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

/** Revert/re-apply order follows occurrence time then immutable submission ID. */
export function byOccurrenceAsc(a: AppliedSettlementEvent, b: AppliedSettlementEvent): number {
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
export function replayClosure(
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

/**
 * Re-derives the plan a sealed legacy row predates, from a reconstructed
 * activation input. Bound by the writer (settle.ts rederiveSettlementPlan):
 * loadScope/derivePlan stay write-side internals, so history assembly reaches
 * them only through this port. Returns the rebuilt plan and whether the scope
 * came from the frozen learning-scope snapshot.
 */
export type RederiveSettlementPlan = (
  tx: Tx,
  input: ActivationSettleInput,
) => Promise<{ plan: SettlementPlan; frozenLearningScope: boolean }>;

export async function candidateHistory(
  tx: Tx,
  subject: FsrsSubject,
  current: SettlementPlan | null,
  cutoff: Date,
  rederive: RederiveSettlementPlan,
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
    const { plan: rebuilt, frozenLearningScope } = await rederive(tx, input);
    if (current && plan === current) {
      current.forgettingSuppressed = rebuilt.forgettingSuppressed;
    }
    if (rebuilt.forgettingSuppressed) continue;
    if (!rebuilt.forgettingInput) throw new Error('sealed candidate inputs unavailable');
    // Old settlements sealed their scheduling subjects even when no part/KC capture exists.
    // Use that frozen group scope, never today's mutable question labels or context.
    const historicalInput = frozenLearningScope
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
export async function candidateStateForRead(
  tx: Tx,
  subject: FsrsSubject,
  now: Date,
  rederive: RederiveSettlementPlan,
) {
  const history = await candidateHistory(tx, subject, null, now, rederive);
  if (history.length === 0)
    return { ...initialCandidateState(subject.id, now), conversion: 'legacy_cold' as const };
  const last = new Date(Math.max(...history.map((f) => f.fact.occurredAt.getTime())));
  return rebuildCandidate(subject.id, history, last, 'legacy_history');
}
