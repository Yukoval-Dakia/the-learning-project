// Learning settlement for one activation, on the caller's transaction.
// The caller already holds learning-state lock G. This layer takes the FSRS subject
// locks first. updateThetaForAttempt then takes its own fsrs and ability_global locks.
// Do not open a top-level transaction. Replay uses a savepoint.
// Occurrence time is the frozen submission time. evaluated_at and activated_at stay separate.
// A regrade is not extra practice: revert and apply share one snapshot, so evidence_count does not grow by one.
// Uniform certain KCs still share one conjunctive theta update.
// Mixed direction or weight stays one call, with per-KC evidence weight.
// There is no second IRT. Answer points are not derived from those weights.
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
// Plan derivation lives in settle-plan, plan application in settle-apply, and
// undo/replay safety in settle-replay. This file owns the public operations and
// the receipt that seals their outcome.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import { SchedulingStateSchema } from '@/core/schema/scheduling-state';
import type { Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import {
  assessment_issuance,
  assessment_submission,
  evaluation_effective_head,
  event,
  material_fsrs_state,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { resolveAbilityGlobalByKnowledgeId } from '@/kernel/read-models/mastery-state';
import { selectedForgettingEngine } from '@/server/fsrs/engine-selection';
import type { ActivationEffect, ActivationSettleInput } from './activate';
import { type ApplyOutcome, type SettlementObservers, executePlan } from './settle-apply';
import {
  derivePlan,
  hasSchedulingEffect,
  loadScope,
  planSubjects,
  rederiveSettlementPlan,
  schedulingSubjects,
} from './settle-plan';
import {
  type AppliedSettlementEvent,
  type FsrsSubject,
  type SettlementPlan,
  byOccurrenceAsc,
  liveAppliedSettlements,
  loadSettlementEvents,
  candidateStateForRead as readCandidateStateForRead,
  replayClosure,
  subjectKey,
} from './settle-read';
import {
  type ReplayRequired,
  findUnattributedNewerWrites,
  preservedUserRatingExists,
  revertSettlementMember,
} from './settle-replay';

export const ASSESSMENT_SETTLEMENT_ACTION = 'experimental:assessment_settlement';
export const ASSESSMENT_SETTLEMENT_VERSION = 1 as const;

/** Read-only legacy conversion. Historical receipts and the stored projection are never rewritten. */
export async function candidateStateForRead(tx: Tx, subject: FsrsSubject, now: Date) {
  return readCandidateStateForRead(tx, subject, now, rederiveSettlementPlan);
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
      kc_wrong_cause: plan?.kcWrongCause ?? null,
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
