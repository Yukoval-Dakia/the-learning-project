// Apply one sealed settlement plan to learning state. The plan is replayed, never
// re-derived or re-judged here: FSRS scheduling, one shared theta update,
// snapshot brackets, then family/label/calibration hooks. Writes stay on the
// caller's transaction; each best-effort hook opens its own savepoint.

import { sql } from 'drizzle-orm';

import { writeAttemptSnapshotBrackets } from '@/capabilities/practice/public';
import { scheduleReview } from '@/core/fsrs';
import { type SchedulingState, isCandidateState } from '@/core/schema/scheduling-state';
import type { Tx } from '@/db/client';
import { getMasteryState } from '@/kernel/read-models/mastery-state';
import { updateThetaForAttempt } from '@/kernel/records/mastery-state';
import {
  candidateObservations,
  candidateRetention,
  rebuildCandidate,
} from '@/server/fsrs/candidate';
import { selectedForgettingEngine } from '@/server/fsrs/engine-selection';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { recordDifficultyCalibrationEvidence } from '@/server/mastery/calibration-evidence';
import {
  type FamilyFoldRecord,
  recordFamilyObservationForAttempt,
} from '@/server/mastery/personalized-difficulty';
import { recordDifficultyCalibrationLabel } from '@/server/mastery/recalibration';
import {
  hasSchedulingEffect,
  planSubjects,
  rederiveSettlementPlan,
  schedulingSubjects,
} from './settle-plan';
import {
  type SettlementPlan,
  candidateHistory,
  candidateSchedulingSuppressed,
  subjectKey,
} from './settle-read';

/** One item-level bit when every KC evidence row agrees. Mixed directions have no such bit. */
function sharedItemOutcome(theta: {
  outcome: 0 | 1;
  kcEvidence?: ReadonlyArray<{ outcome: 0 | 1 }>;
}): 0 | 1 | null {
  const rows = theta.kcEvidence;
  if (rows === undefined) return theta.outcome;
  const first = rows[0]?.outcome;
  if (first === undefined) return theta.outcome;
  return rows.every((row) => row.outcome === first) ? first : null;
}

export interface ApplyOutcome {
  fsrsApplied: string[];
  thetaApplied: string[];
  /** A count-only family write still counts. It did not have to enter the mean. */
  familyObservationRecorded: boolean;
  /** The fold that was written. null never touched the calibration row. */
  familyFold: FamilyFoldRecord | null;
  subjects: Set<string>;
}

/**
 * Apply one plan from its sealed inputs. Do not re-judge.
 * FSRS, then one shared theta update, then brackets, then calibration.
 * Family calibration folds only when theta was applied and every KC evidence row shares one direction.
 */
export interface SettlementObservers {
  /** Runs once for the new occurrence at its own ordered position, never for replayed neighbors. */
  onThetaApplied?: (tx: Tx, input: { knowledgeIds: string[]; outcome: 0 | 1 }) => Promise<void>;
}

export async function executePlan(
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
      await candidateHistory(
        tx,
        plan.fsrsSubjects[0],
        plan,
        occurrenceAt,
        rederiveSettlementPlan,
        [],
      );
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
          rederiveSettlementPlan,
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
  // YUK-439 — 标定证据的 θ̂ 快照：必须在 updateThetaForAttempt **之前**捕获（PRE-attempt，
  // 同 thetaBefore 纪律；批时后验似然 σ(θ_e − b) 锚定它）。无 KC 的锚题按冷启 0。
  let calibrationThetaBefore: number | null = null;
  const calibrationPrimary = plan.calibration?.primaryKnowledgeId ?? null;
  if (plan.calibration !== null) {
    calibrationThetaBefore =
      calibrationPrimary !== null
        ? ((await getMasteryState(tx, calibrationPrimary))?.theta_hat ?? 0)
        : 0;
  }
  if (plan.theta.applied) {
    const theta = plan.theta;
    const familyPrimary = theta.familyPrimaryKnowledgeId ?? theta.knowledgeIds[0] ?? null;
    thetaBefore =
      familyPrimary !== null ? ((await getMasteryState(tx, familyPrimary))?.theta_hat ?? 0) : 0;
    const result = await updateThetaForAttempt(tx, {
      knowledgeIds: theta.knowledgeIds,
      questionId: theta.anchorQuestionId,
      outcome: theta.outcome,
      ...(theta.kcEvidence ? { kcEvidence: theta.kcEvidence } : {}),
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

  const itemOutcome = plan.theta.applied ? sharedItemOutcome(plan.theta) : null;
  if (plan.theta.applied && itemOutcome !== null) {
    const theta = plan.theta;
    try {
      await tx.transaction(async (sp) => {
        outcome.familyFold = await recordFamilyObservationForAttempt(sp, {
          primaryKnowledgeId: theta.familyPrimaryKnowledgeId ?? theta.knowledgeIds[0] ?? null,
          questionId: theta.anchorQuestionId,
          kind: theta.anchorKind,
          source: theta.anchorSource,
          difficulty: theta.anchorDifficulty,
          outcome: itemOutcome,
          attemptOutcome: itemOutcome === 1 ? 'success' : 'failure',
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
  if (plan.theta.applied && itemOutcome !== null) {
    const theta = plan.theta;
    try {
      await tx.transaction(async (sp) => {
        await recordDifficultyCalibrationLabel(sp, {
          questionId: theta.anchorQuestionId,
          attemptEventId: settlementEventId,
          difficulty: theta.anchorDifficulty,
          outcome: itemOutcome,
          attemptOutcome: itemOutcome === 1 ? 'success' : 'failure',
          judgeRoute: plan.judgeRoute,
          thetaBefore,
          now: occurrenceAt,
          streamItemId: plan.difficultyLabelStreamItemId,
        });
      });
    } catch (error) {
      console.warn('[assessment-settle] difficulty calibration label failed (non-fatal):', error);
    }
  }
  if (plan.theta.applied) {
    const theta = plan.theta;
    if (theta.kcEvidence === undefined) {
      await options.onThetaApplied?.(tx, {
        knowledgeIds: theta.knowledgeIds,
        outcome: theta.outcome,
      });
    } else {
      const upIds = theta.kcEvidence.filter((row) => row.outcome === 1).map((row) => row.kc_id);
      if (upIds.length > 0) {
        await options.onThetaApplied?.(tx, { knowledgeIds: upIds, outcome: 1 });
      }
    }
  }
  // YUK-439 (ADR-0043 Amendment A4) — 联合标定证据：连续分数（含 partial）、模型判分、
  // 非 softmax 来源都进（门在 derivePlan 的 calibrationEligible：automatic 且非
  // assisted 且分数已知；theta abstain 不排除）。SAVEPOINT 内 best-effort，同 label
  // hook 纪律；判分真相源是 judge/evaluation event，本 hook 只读 (score, route,
  // provenance) 绝不回写判分——这是掌握更新，不是答案判分。
  if (plan.calibration !== null && plan.verdict.normalized != null) {
    const cal = plan.calibration;
    try {
      await tx.transaction(async (sp) => {
        await recordDifficultyCalibrationEvidence(sp, {
          questionId: cal.questionId,
          attemptEventId: settlementEventId,
          score: plan.verdict.normalized as number,
          judgeRoute: plan.judgeRoute,
          thetaBefore: calibrationThetaBefore ?? 0,
          streamItemId: plan.difficultyLabelStreamItemId,
          containerRef: cal.containerRef,
          now: occurrenceAt,
        });
      });
    } catch (error) {
      console.warn(
        '[assessment-settle] difficulty calibration evidence failed (non-fatal):',
        error,
      );
    }
  }
  return outcome;
}
