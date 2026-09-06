import { and, desc, eq, inArray, isNull, not, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
import { JudgeKind as JudgeKindZ } from '@/core/schema/business';
import { validateCauseAgainstProfile } from '@/core/schema/cause';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { JudgeExecutionProvenanceT } from '@/core/schema/event/known';
import type { AttemptQuestionSnapshotT } from '@/core/schema/question-evidence-snapshot';
import type { Db, Tx } from '@/db/client';
import { answer, event, mastery_state, material_fsrs_state, type question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import { type FsrsSubjectKind, getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { recordFamilyObservationForAttempt } from '@/server/mastery/personalized-difficulty';
import {
  PREREQ_RISK_EMIT_ENABLED,
  emitPrereqRiskSignal,
} from '@/server/mastery/prereq-propagation';
import { recordDifficultyCalibrationLabel } from '@/server/mastery/recalibration';
import {
  ABILITY_GLOBAL_SUBJECT_KIND,
  type AbilityGlobalByKnowledgeId,
  getMasteryState,
  resolveAbilityGlobalSubjectIds,
  updateThetaForAttempt,
} from '@/server/mastery/state';
import type { SubjectProfile } from '@/subjects/profile';
import type { JudgedSubmit, ValidatedSubmit } from '../api/submit';
import { freezeAnswerDraft } from './answer-draft';
import { writeAttemptSnapshotBrackets } from './attempt-snapshot';
import { enqueueWrongStreakNudge } from './enqueue-wrong-streak-nudge';
import { initialFsrsState, scheduleReview } from './fsrs';
import { type JudgeInvokerOutput, deterministicExecutionProvenance } from './judge';
import { ratingFromCoarseOutcome } from './judge-rating';
import { hasNewerAttemptEvidence } from './judge-run-dispatch';
import { emitMasteryProgressSignal } from './mastery-progress-signal';
import { judgeResultToRatingAdvice } from './rating-advisor';

type SoloSettlementPolicy =
  | { kind: 'inline' }
  | {
      kind: 'deferred';
      runId: string;
      /** Explicit undefined is accepted only for pre-freeze legacy queue payloads. */
      frozenAbilityGlobalByKnowledgeId: AbilityGlobalByKnowledgeId | undefined;
    };

interface PersistedSoloReview {
  eventId: string;
  judgeEventId: string | null;
  outcome: 'success' | 'failure';
  fsrsSubjectKind: FsrsSubjectKind;
  fsrsSubjectIds: string[];
  finalResult: ReturnType<typeof scheduleReview>;
  finalFsrsStateAfter: ReturnType<typeof scheduleReview>['nextState'] & {
    last_review: Date | null;
  };
  lateArrival: boolean;
}

type LearningEffect = 'applied' | 'evidence_only_late' | 'ungraded';

interface FsrsUpdate {
  subject_kind: FsrsSubjectKind;
  subject_id: string;
  result: ReturnType<typeof scheduleReview>;
  stateAfter: PersistedSoloReview['finalFsrsStateAfter'];
  before: FsrsStateSchemaT | null;
}

interface LearningEffects {
  effect: LearningEffect;
  attemptEventId: string;
  sessionId: string | null;
  now: Date;
  question: QuestionRow;
  rating: 'again' | 'hard' | 'good';
  attemptOutcome: PaperAttemptOutcome;
  fsrs: {
    subjectKind: FsrsSubjectKind;
    subjectIds: string[];
  };
  theta: {
    enabled: boolean;
    knowledgeIds: string[];
    responseTimeMs?: number;
    abilityGlobalByKnowledgeId?: AbilityGlobalByKnowledgeId;
  };
  calibration: null | {
    judgeRoute: string | null;
    attemptOutcome?: PaperAttemptOutcome;
    streamItemId: string | null;
  };
}

/**
 * One private owner for the order-sensitive learning-state protocol.
 *
 * Callers already hold the global learning-state lock and their aggregate
 * session/question locks. This function acquires sorted FSRS locks, captures
 * pre-state, computes schedules, writes immutable evidence through the private
 * callback, then materializes FSRS/θ̂/snapshot brackets and isolated
 * calibration savepoints. No caller can selectively toggle one derived write.
 */
async function applyLearningEffects<T>(
  tx: Tx,
  input: LearningEffects,
  writeEvidence: (fsrsUpdates: FsrsUpdate[]) => Promise<T>,
): Promise<{ evidence: T; fsrsUpdates: FsrsUpdate[] }> {
  const fsrsUpdates: FsrsUpdate[] = [];
  if (input.effect !== 'ungraded') {
    for (const subjectId of [...input.fsrs.subjectIds].sort()) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:${input.fsrs.subjectKind}:${subjectId}`}))`,
      );
    }
    for (const subjectId of input.fsrs.subjectIds) {
      try {
        let source = await getFsrsState(tx, input.fsrs.subjectKind, subjectId);
        const before = source?.state ?? null;
        if (!source && input.fsrs.subjectKind === 'knowledge') {
          source = await getFsrsState(tx, 'question', input.question.id);
        }
        let result = scheduleReview(
          source?.state ? { ...source.state, last_review: source.state.last_review ?? null } : null,
          input.rating,
          input.now,
        );
        let stateAfter: FsrsUpdate['stateAfter'] = {
          ...result.nextState,
          due: result.nextState.due,
          last_review: result.nextState.last_review ?? null,
        };
        if (input.effect === 'evidence_only_late') {
          if (before) {
            result = {
              nextState: before,
              dueAt: coerceJsonbDate(before.due) ?? input.now,
            };
            stateAfter = before;
          } else {
            const initial = initialFsrsState(input.now);
            result = { nextState: initial.state, dueAt: initial.dueAt };
            stateAfter = {
              ...initial.state,
              last_review: initial.state.last_review ?? null,
            };
          }
        }
        fsrsUpdates.push({
          subject_kind: input.fsrs.subjectKind,
          subject_id: subjectId,
          result,
          stateAfter,
          before,
        });
      } catch (err) {
        console.error('review settlement preparation failed', {
          questionId: input.question.id,
          fsrsSubjectKind: input.fsrs.subjectKind,
          fsrsSubjectId: subjectId,
          err,
        });
        throw new ApiError(
          'corrupt_state',
          `material_fsrs_state for ${input.fsrs.subjectKind} ${subjectId} could not be parsed; please reset this card`,
          422,
        );
      }
    }
  }

  const evidence = await writeEvidence(fsrsUpdates);
  if (input.effect !== 'applied') return { evidence, fsrsUpdates };

  for (const update of fsrsUpdates) {
    await upsertFsrsState(tx, {
      subject_kind: update.subject_kind,
      subject_id: update.subject_id,
      state: update.stateAfter,
      due_at: update.result.dueAt,
      last_review_event_id: input.attemptEventId,
    });
  }

  const familyPrimaryKnowledgeId = input.question.knowledge_ids[0];
  const needsThetaContext = input.theta.enabled || input.calibration !== null;
  const familyThetaBefore =
    needsThetaContext && familyPrimaryKnowledgeId
      ? ((await getMasteryState(tx, familyPrimaryKnowledgeId))?.theta_hat ?? 0)
      : 0;
  const thetaSnapshots = input.theta.enabled
    ? (
        await updateThetaForAttempt(tx, {
          knowledgeIds: input.theta.knowledgeIds,
          questionId: input.question.id,
          outcome: input.attemptOutcome === 'failure' ? 0 : 1,
          difficulty: input.question.difficulty,
          attemptEventId: input.attemptEventId,
          now: input.now,
          ...(input.theta.responseTimeMs === undefined
            ? {}
            : { responseTimeMs: input.theta.responseTimeMs }),
          kind: input.question.kind,
          source: input.question.source,
          familyPrimaryKnowledgeId,
          ...(input.theta.abilityGlobalByKnowledgeId === undefined
            ? {}
            : { abilityGlobalByKnowledgeId: input.theta.abilityGlobalByKnowledgeId }),
        })
      ).theta_snapshots
    : [];

  await writeAttemptSnapshotBrackets(tx, {
    attemptEventId: input.attemptEventId,
    sessionId: input.sessionId,
    now: input.now,
    thetaSnapshots,
    fsrsSnapshots: fsrsUpdates.map((update) => ({
      subject_kind: update.subject_kind,
      subject_id: update.subject_id,
      before: update.before,
      after: update.stateAfter,
    })),
  });

  const calibration = input.calibration;
  if (calibration) {
    try {
      await tx.transaction(async (sp) => {
        await recordFamilyObservationForAttempt(sp, {
          primaryKnowledgeId: familyPrimaryKnowledgeId,
          questionId: input.question.id,
          kind: input.question.kind,
          source: input.question.source,
          difficulty: input.question.difficulty,
          outcome: input.attemptOutcome === 'failure' ? 0 : 1,
          ...(calibration.attemptOutcome === undefined
            ? {}
            : { attemptOutcome: calibration.attemptOutcome }),
          judgeRoute: calibration.judgeRoute,
          thetaBefore: familyThetaBefore,
          now: input.now,
        });
      });
    } catch (err) {
      console.warn('recordFamilyObservationForAttempt failed (non-fatal):', err);
    }
    try {
      await tx.transaction(async (sp) => {
        await recordDifficultyCalibrationLabel(sp, {
          questionId: input.question.id,
          attemptEventId: input.attemptEventId,
          difficulty: input.question.difficulty,
          outcome: input.attemptOutcome === 'failure' ? 0 : 1,
          ...(calibration.attemptOutcome === undefined
            ? {}
            : { attemptOutcome: calibration.attemptOutcome }),
          judgeRoute: calibration.judgeRoute,
          thetaBefore: familyThetaBefore,
          now: input.now,
          streamItemId: calibration.streamItemId,
        });
      });
    } catch (err) {
      console.warn('recordDifficultyCalibrationLabel failed (non-fatal):', err);
    }
  }

  return { evidence, fsrsUpdates };
}

export interface SoloReviewFacts {
  validated: ValidatedSubmit;
  judged: JudgedSubmit;
}

interface SettlementReceipt {
  attemptEventId: string;
  judgeEventId: string | null;
  effect: LearningEffect;
}

export interface InlineSoloReviewReceipt extends SettlementReceipt {
  effect: 'applied';
  outcome: 'success' | 'failure';
  fsrsSubjectKind: FsrsSubjectKind;
  fsrsSubjectIds: string[];
  finalResult: PersistedSoloReview['finalResult'];
  finalFsrsStateAfter: PersistedSoloReview['finalFsrsStateAfter'];
}

export interface DeferredSoloReviewCommand extends SoloReviewFacts {
  runId: string;
  /** Required acknowledgement; undefined preserves pre-freeze in-flight compatibility. */
  frozenAbilityGlobalByKnowledgeId: AbilityGlobalByKnowledgeId | undefined;
}

export interface DeferredSoloReviewReceipt extends SettlementReceipt {
  effect: 'applied' | 'evidence_only_late';
  lateArrival: boolean;
  terminalResult: {
    attempt_event_id: string;
    judge_event_id: string | null;
    outcome: 'success' | 'failure';
    final_rating: JudgedSubmit['finalRating'];
    route: string | null;
  };
}

async function detectLateArrival(
  tx: Tx,
  input: {
    now: Date;
    fsrsSubjectKind: FsrsSubjectKind;
    fsrsSubjectIds: string[];
    knowledgeIds: string[];
    questionId: string;
    /** This attempt's own run handle — its own pending row must not indict it. */
    runId: string;
    abilityGlobalByKnowledgeId?: AbilityGlobalByKnowledgeId;
  },
): Promise<boolean> {
  const {
    now,
    fsrsSubjectKind,
    fsrsSubjectIds,
    knowledgeIds,
    questionId,
    runId,
    abilityGlobalByKnowledgeId,
  } = input;
  const nowMs = now.getTime();
  // Resolve the shared hierarchical-Elo write targets once. The immutable-evidence check and
  // projection check must cover the same domain rows this attempt would update.
  const abilityGlobalIds =
    abilityGlobalByKnowledgeId === undefined
      ? await resolveAbilityGlobalSubjectIds(tx, knowledgeIds)
      : Array.from(new Set(Object.values(abilityGlobalByKnowledgeId)));

  // (a) Evidence first — it is both the cheapest to reason about and the only half that
  // survives a preceding skip.
  if (
    await hasNewerAttemptEvidence(tx, {
      submittedAt: now,
      questionId,
      knowledgeIds,
      abilityGlobalIds,
      excludeRunId: runId,
    })
  ) {
    return true;
  }

  if (fsrsSubjectIds.length > 0) {
    const rows = await tx
      .select({ state: material_fsrs_state.state })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, fsrsSubjectKind),
          inArray(material_fsrs_state.subject_id, fsrsSubjectIds),
        ),
      );
    for (const row of rows) {
      const lastReview = coerceJsonbDate(row.state?.last_review ?? null);
      if (lastReview !== null && lastReview.getTime() > nowMs) return true;
    }
  }

  // θ̂ is written for the question's FULL label set, independent of the FSRS subset.
  const thetaSubjectIds = Array.from(new Set(knowledgeIds)).filter((id) => id.length > 0);
  if (thetaSubjectIds.length > 0) {
    const rows = await tx
      .select({ lastOutcomeAt: mastery_state.last_outcome_at })
      .from(mastery_state)
      // W5 #TusVG — `subject_kind` is HALF the key. `mastery_state` is unique on
      // (subject_kind, subject_id) and hosts hierarchical-Elo `ability_global` rows keyed by a
      // DOMAIN id in a separate partition, so filtering on `subject_id` alone can pick up a
      // non-knowledge row's `last_outcome_at`. A hit there would misread a perfectly ordered
      // backfill as late and silently skip EVERY derived write. Same filter the write side
      // uses (`updateThetaForAttempt`, mastery/state.ts:226) so the read and write agree.
      .where(
        and(
          eq(mastery_state.subject_kind, 'knowledge'),
          inArray(mastery_state.subject_id, thetaSubjectIds),
        ),
      );
    for (const row of rows) {
      const lastOutcomeAt = coerceJsonbDate(row.lastOutcomeAt);
      if (lastOutcomeAt !== null && lastOutcomeAt.getTime() > nowMs) return true;
    }
  }

  // YUK-777 B1 — the SHARED per-domain θ_global rows. Empty (and unread) when
  // HIERARCHICAL_ELO_ENABLED is off, because then no global row is written either.
  if (abilityGlobalIds.length > 0) {
    const rows = await tx
      .select({ lastOutcomeAt: mastery_state.last_outcome_at })
      .from(mastery_state)
      .where(
        and(
          eq(mastery_state.subject_kind, ABILITY_GLOBAL_SUBJECT_KIND),
          inArray(mastery_state.subject_id, abilityGlobalIds),
        ),
      );
    for (const row of rows) {
      const lastOutcomeAt = coerceJsonbDate(row.lastOutcomeAt);
      if (lastOutcomeAt !== null && lastOutcomeAt.getTime() > nowMs) return true;
    }
  }

  return false;
}

async function settleSoloReview(
  db: Db,
  { body, now, questionId, q }: ValidatedSubmit,
  judged: JudgedSubmit,
  policy: SoloSettlementPolicy,
): Promise<PersistedSoloReview> {
  const questionKnowledgeIds = Array.from(
    new Set(q.knowledge_ids.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  const requestedKnowledgeIds = Array.from(
    new Set(body.referenced_knowledge_ids.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  const referencedKnowledgeIds =
    requestedKnowledgeIds.length > 0 ? requestedKnowledgeIds : questionKnowledgeIds;
  const requestedIntersection = requestedKnowledgeIds.filter((id) =>
    questionKnowledgeIds.includes(id),
  );
  const fsrsKnowledgeIds =
    requestedKnowledgeIds.length === 0
      ? questionKnowledgeIds
      : requestedIntersection.length > 0
        ? requestedIntersection
        : questionKnowledgeIds;
  const fsrsSubjectKind: FsrsSubjectKind = fsrsKnowledgeIds.length > 0 ? 'knowledge' : 'question';
  const fsrsSubjectIds = fsrsSubjectKind === 'knowledge' ? fsrsKnowledgeIds : [questionId];
  const outcome: 'success' | 'failure' = judged.finalRating === 'again' ? 'failure' : 'success';
  const eventId = policy.kind === 'deferred' ? policy.runId : newId();
  const judgePayload =
    judged.judgeResult !== null && judged.judgeRoute !== null
      ? {
          judge: {
            route: judged.judgeRoute,
            score: judged.judgeResult.score,
            score_meaning: judged.judgeResult.score_meaning,
            coarse_outcome: judged.judgeResult.coarse_outcome,
            confidence: judged.judgeResult.confidence,
            feedback_md: judged.judgeResult.feedback_md,
            evidence_json: judged.judgeResult.evidence_json,
            capability_ref: judged.judgeResult.capability_ref,
            suggested_rating: judged.suggestedRating,
            auto_rated: body.auto_rate,
            ...(judged.judgeTelemetry !== null ? { telemetry: judged.judgeTelemetry } : {}),
          },
        }
      : {};
  const judgeAdvicePayload =
    judged.judgeResult !== null
      ? {
          judge_advice: {
            ...judgeResultToRatingAdvice(judged.judgeResult, {
              causeCategory: judged.adviceCauseCategory,
              subjectProfile: judged.adviceSubjectProfile,
            }),
          },
        }
      : {};

  let lateArrival = false;
  const settled = await db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    await tx.execute(sql`SELECT id FROM question WHERE id = ${questionId} FOR UPDATE`);
    lateArrival =
      policy.kind === 'deferred'
        ? await detectLateArrival(tx, {
            now,
            fsrsSubjectKind,
            fsrsSubjectIds,
            knowledgeIds: q.knowledge_ids,
            questionId,
            runId: eventId,
            abilityGlobalByKnowledgeId: policy.frozenAbilityGlobalByKnowledgeId,
          })
        : false;
    const effect: LearningEffect = lateArrival ? 'evidence_only_late' : 'applied';
    if (lateArrival) {
      console.warn(
        '[review-settlement] late deferred attempt records evidence without derived writes',
        { eventId, questionId, submittedAt: now.toISOString() },
      );
    }
    return await applyLearningEffects(
      tx,
      {
        effect,
        attemptEventId: eventId,
        sessionId: body.session_id ?? null,
        now,
        question: q,
        rating: judged.finalRating,
        attemptOutcome: outcome,
        fsrs: { subjectKind: fsrsSubjectKind, subjectIds: fsrsSubjectIds },
        theta: {
          enabled: true,
          knowledgeIds: q.knowledge_ids,
          ...(body.latency_ms == null ? {} : { responseTimeMs: body.latency_ms }),
          ...(policy.kind === 'deferred' && policy.frozenAbilityGlobalByKnowledgeId !== undefined
            ? { abilityGlobalByKnowledgeId: policy.frozenAbilityGlobalByKnowledgeId }
            : {}),
        },
        calibration: body.auto_rate
          ? {
              judgeRoute: judged.judgeRoute,
              streamItemId: body.stream_item_id ?? null,
            }
          : null,
      },
      async (fsrsUpdates) => {
        const primary = fsrsUpdates[0];
        await writeEvent(tx, {
          id: eventId,
          session_id: body.session_id ?? null,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'review',
          subject_kind: 'question',
          subject_id: questionId,
          outcome,
          payload: {
            fsrs_rating: judged.finalRating,
            fsrs_subject_kind: fsrsSubjectKind,
            fsrs_subject_ids: fsrsSubjectIds,
            fsrs_state_after: primary.stateAfter,
            fsrs_state_after_by_subject: fsrsUpdates.map((update) => ({
              subject_kind: update.subject_kind,
              subject_id: update.subject_id,
              state: update.stateAfter,
              due_at: update.result.dueAt,
            })),
            user_response_md: body.response_md ?? null,
            answer_image_refs: body.answer_image_refs,
            referenced_knowledge_ids: referencedKnowledgeIds,
            ...(typeof body.latency_ms === 'number' ? { duration_ms: body.latency_ms } : {}),
            ...(body.stream_item_id ? { stream_item_id: body.stream_item_id } : {}),
            ...(body.reasoning_trace?.trim() ? { reasoning_trace: body.reasoning_trace } : {}),
            ...(typeof body.self_confidence === 'number'
              ? { self_confidence: body.self_confidence }
              : {}),
            ...judgePayload,
            ...judgeAdvicePayload,
          },
          caused_by_event_id: null,
          task_run_id: null,
          cost_micro_usd: null,
          created_at: now,
        });
        let judgeEventId: string | null = null;
        if (
          judged.judgeResult !== null &&
          judged.judgeRoute !== null &&
          JudgeKindZ.safeParse(judged.judgeRoute).success
        ) {
          judgeEventId = newId();
          await writeEvent(tx, {
            id: judgeEventId,
            session_id: body.session_id ?? null,
            actor_kind: 'agent',
            actor_ref: 'review_judge',
            action: 'judge',
            subject_kind: 'event',
            subject_id: eventId,
            outcome: 'success',
            payload: {
              cause: {
                primary_category: 'other',
                secondary_categories: [],
                analysis_md: '<review-submit, attribution deferred>',
                confidence: judged.judgeResult.confidence,
              },
              referenced_knowledge_ids: referencedKnowledgeIds,
              profile_version: judged.judgeResult.capability_ref.version,
              capability_ref: judged.judgeResult.capability_ref,
              judge_route: judged.judgeRoute,
              execution_provenance:
                judged.executionProvenance ?? deterministicExecutionProvenance(judged.judgeRoute),
              coarse_outcome: judged.judgeResult.coarse_outcome,
              ...(judged.judgeResult.score != null ? { score: judged.judgeResult.score } : {}),
              feedback_md: judged.judgeResult.feedback_md,
              attribution_pending: true,
              ...(body.part_ref ? { sub_ref: body.part_ref } : {}),
            },
            caused_by_event_id: eventId,
            task_run_id: judged.executionProvenance?.task_run_id ?? null,
            cost_micro_usd: null,
            created_at: now,
          });
        }
        return { judgeEventId };
      },
    );
  });

  const effect: LearningEffect = lateArrival ? 'evidence_only_late' : 'applied';
  await emitSettlementSignals(db, {
    effect,
    outcome,
    knowledgeIds: q.knowledge_ids,
    questionId,
    sourceArtifactId: q.source_ref,
    attemptEventId: eventId,
    now,
  });
  const primary = settled.fsrsUpdates[0];
  return {
    eventId,
    judgeEventId: settled.evidence.judgeEventId,
    outcome,
    fsrsSubjectKind,
    fsrsSubjectIds,
    finalResult: primary.result,
    finalFsrsStateAfter: primary.stateAfter,
    lateArrival,
  };
}

function coerceJsonbDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const asDate = value instanceof Date ? value : new Date(value);
  return Number.isNaN(asDate.getTime()) ? null : asDate;
}

export async function settleInlineSoloReview(
  db: Db,
  command: SoloReviewFacts,
): Promise<InlineSoloReviewReceipt> {
  const settled = await settleSoloReview(db, command.validated, command.judged, { kind: 'inline' });
  return {
    attemptEventId: settled.eventId,
    judgeEventId: settled.judgeEventId,
    effect: 'applied',
    outcome: settled.outcome,
    fsrsSubjectKind: settled.fsrsSubjectKind,
    fsrsSubjectIds: settled.fsrsSubjectIds,
    finalResult: settled.finalResult,
    finalFsrsStateAfter: settled.finalFsrsStateAfter,
  };
}

export async function settleDeferredSoloReview(
  db: Db,
  command: DeferredSoloReviewCommand,
): Promise<DeferredSoloReviewReceipt> {
  const settled = await settleSoloReview(db, command.validated, command.judged, {
    kind: 'deferred',
    runId: command.runId,
    frozenAbilityGlobalByKnowledgeId: command.frozenAbilityGlobalByKnowledgeId,
  });
  return {
    attemptEventId: settled.eventId,
    judgeEventId: settled.judgeEventId,
    effect: settled.lateArrival ? 'evidence_only_late' : 'applied',
    lateArrival: settled.lateArrival,
    terminalResult: {
      attempt_event_id: settled.eventId,
      judge_event_id: settled.judgeEventId,
      outcome: settled.outcome,
      final_rating: command.judged.finalRating,
      route: command.judged.judgeRoute,
    },
  };
}

type QuestionRow = typeof question.$inferSelect;
type PaperAttemptOutcome = 'success' | 'failure' | 'partial';

export interface PaperSlotReviewCommand {
  paper: {
    sessionId: string;
    artifactId: string;
    partRef: string | null;
    feedbackPolicy: string | null;
  };
  answerSnapshot: {
    markdown: string;
    imageRefs: string[];
    question: AttemptQuestionSnapshotT;
    latencyMs?: number;
    reasoningTrace?: string;
  };
  question: QuestionRow;
  knowledge: {
    primaryId: string | null;
    secondaryIds: string[];
  };
  judgement:
    | { kind: 'ungraded'; reason: 'photo_only_unsupported' }
    | {
        kind: 'graded';
        invocation: JudgeInvokerOutput;
        executionProvenance: JudgeExecutionProvenanceT;
        subjectProfile: SubjectProfile;
      };
  submittedAt: Date;
}

export interface PaperSlotReviewReceipt {
  attemptEventId: string;
  judgeEventId: string;
  effect: 'applied' | 'ungraded';
  answerId: string;
  visibleToUser: boolean;
  coarseOutcome: string;
  score: number | null;
  replayed: boolean;
}

function sameImageRefs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function lockPaperSessionAndReadAnswer(
  tx: Tx,
  command: PaperSlotReviewCommand,
): Promise<{
  sessionStartedAt: Date;
  latestFrozen:
    | {
        id: string;
        event_id: string | null;
        content_md: string;
        image_refs: string[];
        submitted_at: Date | null;
      }
    | undefined;
}> {
  const rows = await tx.execute<{
    type: string;
    status: string;
    artifact_id: string | null;
    started_at: string;
  }>(
    sql`SELECT type, status, artifact_id, started_at
        FROM learning_session
        WHERE id = ${command.paper.sessionId}
        FOR UPDATE`,
  );
  const session = (
    rows as unknown as Array<{
      type: string;
      status: string;
      artifact_id: string | null;
      started_at: string;
    }>
  )[0];
  if (session?.type !== 'review' || session.artifact_id !== command.paper.artifactId) {
    throw new ApiError('validation_error', 'paper review session binding is invalid', 400);
  }
  if (session.status !== 'started' && session.status !== 'paused') {
    throw new ApiError(
      'validation_error',
      `session ${command.paper.sessionId} is in status '${session.status}' and cannot accept submissions`,
      400,
    );
  }
  const [latestFrozen] = await tx
    .select({
      id: answer.id,
      event_id: answer.event_id,
      content_md: answer.content_md,
      image_refs: answer.image_refs,
      submitted_at: answer.submitted_at,
    })
    .from(answer)
    .where(
      and(
        eq(answer.session_id, command.paper.sessionId),
        eq(answer.question_id, command.question.id),
        sql`COALESCE(${answer.part_ref}, '') = COALESCE(${command.paper.partRef}, '')`,
        not(isNull(answer.submitted_at)),
      ),
    )
    .orderBy(desc(answer.submitted_at))
    .limit(1);
  return { sessionStartedAt: new Date(session.started_at), latestFrozen };
}

function paperReplayReceipt(
  frozen: NonNullable<Awaited<ReturnType<typeof lockPaperSessionAndReadAnswer>>['latestFrozen']>,
  judge: { id: string; payload: unknown } | undefined,
): PaperSlotReviewReceipt {
  const payload = judge?.payload as {
    coarse_outcome?: string;
    score?: number;
    visible_to_user?: boolean;
  } | null;
  const coarseOutcome = payload?.coarse_outcome ?? 'unsupported';
  return {
    attemptEventId: frozen.event_id ?? frozen.id,
    judgeEventId: judge?.id ?? frozen.event_id ?? frozen.id,
    effect: judge ? 'applied' : 'ungraded',
    answerId: frozen.id,
    visibleToUser: payload?.visible_to_user !== false,
    coarseOutcome,
    score: payload?.score ?? null,
    replayed: true,
  };
}

async function emitSettlementSignals(
  db: Db,
  input: {
    effect: 'applied' | 'evidence_only_late' | 'ungraded';
    outcome: PaperAttemptOutcome;
    knowledgeIds: string[];
    questionId: string;
    sourceArtifactId: string | null;
    attemptEventId: string;
    now: Date;
  },
): Promise<void> {
  if (input.effect !== 'applied') return;
  if (input.outcome === 'success') {
    await emitMasteryProgressSignal({
      db,
      knowledgeIds: input.knowledgeIds,
      questionId: input.questionId,
      sourceArtifactId: input.sourceArtifactId,
      attemptEventId: input.attemptEventId,
      now: input.now,
    });
  }
  await enqueueWrongStreakNudge(input.outcome, input.attemptEventId);
  if (PREREQ_RISK_EMIT_ENABLED && input.outcome === 'failure') {
    await emitPrereqRiskSignal({
      db,
      failedKnowledgeIds: input.knowledgeIds,
      questionId: input.questionId,
      attemptEventId: input.attemptEventId,
      now: input.now,
    });
  }
}

export async function settlePaperSlotReview(
  db: Db,
  command: PaperSlotReviewCommand,
): Promise<PaperSlotReviewReceipt> {
  const { question: q, submittedAt: now } = command;
  const gradedJudgement = command.judgement.kind === 'graded' ? command.judgement : null;
  const graded = gradedJudgement !== null;
  const invocation = gradedJudgement?.invocation ?? null;
  const judgeResult = invocation?.result ?? null;
  const coarseOutcome = judgeResult?.coarse_outcome ?? 'unsupported';
  const rating = ratingFromCoarseOutcome(coarseOutcome) ?? 'again';
  const attemptOutcome: PaperAttemptOutcome =
    coarseOutcome === 'correct' ? 'success' : coarseOutcome === 'partial' ? 'partial' : 'failure';
  const fsrsSubjectKind: FsrsSubjectKind = command.knowledge.primaryId ? 'knowledge' : 'question';
  const fsrsSubjectId = command.knowledge.primaryId ?? q.id;
  const referencedKnowledgeIds = command.knowledge.primaryId
    ? [command.knowledge.primaryId, ...command.knowledge.secondaryIds]
    : q.knowledge_ids;
  const visibleToUser = !graded || command.paper.feedbackPolicy !== 'judge_now_show_later';
  const attemptEventId = newId();
  const proposedJudgeEventId = graded ? newId() : attemptEventId;
  const cause =
    command.judgement.kind === 'graded'
      ? validateCauseAgainstProfile(
          {
            primary_category: 'other',
            secondary_categories: [],
            analysis_md: '<paper-submit, attribution deferred>',
            confidence: command.judgement.invocation.result.confidence,
          },
          command.judgement.subjectProfile,
        )
      : null;

  const receipt = await db.transaction(async (tx): Promise<PaperSlotReviewReceipt> => {
    await acquireLearningStateWriteLock(tx);
    const { sessionStartedAt, latestFrozen } = await lockPaperSessionAndReadAnswer(tx, command);
    await tx.execute(sql`SELECT id FROM question WHERE id = ${q.id} FOR UPDATE`);
    if (latestFrozen) {
      const currentAttempt =
        latestFrozen.submitted_at != null && latestFrozen.submitted_at >= sessionStartedAt;
      if (
        currentAttempt &&
        latestFrozen.event_id &&
        latestFrozen.content_md === command.answerSnapshot.markdown &&
        sameImageRefs(latestFrozen.image_refs, command.answerSnapshot.imageRefs)
      ) {
        const [judge] = await tx
          .select({ id: event.id, payload: event.payload })
          .from(event)
          .where(
            and(
              eq(event.action, 'judge'),
              eq(event.subject_kind, 'event'),
              eq(event.subject_id, latestFrozen.event_id),
            ),
          )
          .limit(1);
        return paperReplayReceipt(latestFrozen, judge);
      }
      if (currentAttempt) {
        throw new ApiError(
          'conflict',
          `slot (question ${q.id}) was already submitted in this session attempt; abandon and reopen the session before changing your answer`,
          409,
        );
      }
    }

    const effect: LearningEffect = graded ? 'applied' : 'ungraded';
    await applyLearningEffects(
      tx,
      {
        effect,
        attemptEventId,
        sessionId: command.paper.sessionId,
        now,
        question: q,
        rating,
        attemptOutcome,
        fsrs: {
          subjectKind: fsrsSubjectKind,
          subjectIds: graded ? [fsrsSubjectId] : [],
        },
        theta: {
          enabled: graded && coarseOutcome !== 'unsupported',
          knowledgeIds: referencedKnowledgeIds,
        },
        calibration:
          graded && coarseOutcome !== 'unsupported'
            ? {
                judgeRoute: invocation?.route ?? null,
                attemptOutcome,
                streamItemId: null,
              }
            : null,
      },
      async () => {
        await writeEvent(tx, {
          id: attemptEventId,
          session_id: command.paper.sessionId,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'attempt',
          subject_kind: 'question',
          subject_id: q.id,
          outcome: attemptOutcome,
          payload: {
            answer_md: command.answerSnapshot.markdown,
            answer_image_refs: command.answerSnapshot.imageRefs,
            referenced_knowledge_ids: referencedKnowledgeIds,
            question_snapshot: command.answerSnapshot.question,
            ...(command.answerSnapshot.latencyMs !== undefined
              ? { duration_ms: command.answerSnapshot.latencyMs }
              : {}),
            ...(command.answerSnapshot.reasoningTrace?.trim()
              ? { reasoning_trace: command.answerSnapshot.reasoningTrace }
              : {}),
            ...(!graded ? { unsupported_judge: true } : {}),
          },
          caused_by_event_id: null,
          created_at: now,
        });
        if (command.judgement.kind === 'graded' && cause !== null) {
          await writeEvent(tx, {
            id: proposedJudgeEventId,
            session_id: command.paper.sessionId,
            actor_kind: 'agent',
            actor_ref: 'paper_judge',
            action: 'judge',
            subject_kind: 'event',
            subject_id: attemptEventId,
            outcome: 'success',
            payload: {
              cause,
              referenced_knowledge_ids: referencedKnowledgeIds,
              profile_version: command.judgement.subjectProfile.version,
              capability_ref: command.judgement.invocation.result.capability_ref,
              judge_route: command.judgement.invocation.route,
              execution_provenance: command.judgement.executionProvenance,
              ...(visibleToUser ? {} : { visible_to_user: false }),
              coarse_outcome: coarseOutcome,
              ...(judgeResult?.score != null ? { score: judgeResult.score } : {}),
              feedback_md: judgeResult?.feedback_md ?? '',
              attribution_pending: true,
              ...(command.paper.partRef ? { sub_ref: command.paper.partRef } : {}),
            },
            caused_by_event_id: attemptEventId,
            task_run_id: command.judgement.executionProvenance.task_run_id ?? null,
            created_at: now,
          });
        }
      },
    );

    const frozen = await freezeAnswerDraft(tx, {
      sessionId: command.paper.sessionId,
      questionId: q.id,
      partRef: command.paper.partRef,
      eventId: attemptEventId,
      inputKind: command.answerSnapshot.imageRefs.length > 0 ? 'image' : 'text',
      contentMd: command.answerSnapshot.markdown,
      imageRefs: command.answerSnapshot.imageRefs,
      paperArtifactId: command.paper.artifactId,
    });
    return {
      attemptEventId,
      judgeEventId: proposedJudgeEventId,
      effect,
      answerId: frozen.answerId,
      visibleToUser,
      coarseOutcome,
      score: judgeResult?.score ?? null,
      replayed: false,
    };
  });

  if (!receipt.replayed) {
    await emitSettlementSignals(db, {
      effect: receipt.effect,
      outcome: attemptOutcome,
      knowledgeIds: q.knowledge_ids,
      questionId: q.id,
      sourceArtifactId: q.source_ref,
      attemptEventId: receipt.attemptEventId,
      now,
    });
  }
  return receipt;
}
