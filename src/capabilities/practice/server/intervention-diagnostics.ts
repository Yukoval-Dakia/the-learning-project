import { and, desc, eq, sql } from 'drizzle-orm';
import { ReviewOnQuestion } from '@/core/schema/event/known';
import {
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
  InterventionDiagnosticQuestionMetadata,
  type InterventionPackageT,
  type InterventionSettlementT,
  type InterventionSnapshotT,
} from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import { getEventById } from '@/kernel/events';
import {
  loadLatestTrustedInterventionDiagnosticVerdict,
  loadNativeInterventionDiagnosticState,
} from '@/kernel/read-models/intervention-diagnostic-verdict';
import {
  type DiagnosticMaterializeEffects,
  applyDiagnosticMaterialization,
} from '@/kernel/records/intervention-diagnostic-materialize';
import {
  enrollFsrsStateIfAbsent,
  initialSchedulingState,
  retireQuestionFsrsState,
} from '@/server/fsrs/state';
import { JUDGE_PENDING_ATTEMPT_ACTION } from './judge-run-dispatch';
import { readJudgeQuestionActivity } from './judge-run-observation';
import { streamLocalDate } from './stream-date';

export const INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS = 10 * 60 * 1000;

async function enrollQuestionFsrsIfAbsent(tx: Tx, questionId: string, dueAt: Date): Promise<void> {
  await enrollFsrsStateIfAbsent(tx, {
    subject_kind: 'question',
    subject_id: questionId,
    ...initialSchedulingState(questionId, dueAt),
    last_review_event_id: null,
  });
}

export function diagnosticMaterializeEffects(): DiagnosticMaterializeEffects {
  return {
    claimLeaseMs: INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS,
    pendingAttemptAction: JUDGE_PENDING_ATTEMPT_ACTION,
    streamLocalDate,
    readJudgeQuestionActivity,
    retireQuestionFsrsState,
    enrollQuestionFsrsIfAbsent,
  };
}

interface MaterializeInterventionDiagnosticsInput {
  package: InterventionPackageT;
  settlement: InterventionSettlementT;
  snapshot: InterventionSnapshotT;
  now: Date;
  /**
   * Set only by the aggregate transaction that records the first immediate review:
   * activates and re-enrolls the anchored follow-ups in the same settlement update.
   */
  activateAnchoredFollowups?: boolean;
}

export async function materializeInterventionDiagnostics(
  tx: Tx,
  input: MaterializeInterventionDiagnosticsInput,
): Promise<void> {
  await applyDiagnosticMaterialization(tx, input, diagnosticMaterializeEffects());
}

export function questionKnowledgeIdsForJudge(input: {
  source: string | null;
  metadata: Record<string, unknown> | null;
  knowledge_ids: string[] | null;
}): string[] {
  if (input.source !== INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
    return input.knowledge_ids ?? [];
  }
  const diagnostic = InterventionDiagnosticQuestionMetadata.parse(
    input.metadata?.intervention_diagnostic,
  );
  return [diagnostic.knowledge_id];
}

export interface CommittedInterventionDiagnosticAttempt {
  review_event: {
    id: string;
    rating: 'again' | 'hard' | 'good' | null;
  };
  judge: {
    route: 'multimodal_direct' | 'evaluate_submission';
    coarse_outcome: 'correct' | 'partial' | 'incorrect' | 'unsupported';
    confidence: number;
    feedback_md: string;
    suggested_rating: 'again' | 'hard' | 'good' | null;
    judge_event_id: string | null;
    evaluation_id?: string;
  };
}

/**
 * Recover the canonical one-shot result after refresh, response loss, or a duplicate
 * submission. The active trusted judge event owns the verdict; the immutable review
 * supplies the rating and, for historical rows without feedback_md, a fallback string.
 */
export async function loadCommittedInterventionDiagnosticAttempt(
  db: Db,
  questionId: string,
): Promise<CommittedInterventionDiagnosticAttempt | null> {
  const nativeAttempts = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_attempt'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(50);
  for (const attempt of nativeAttempts) {
    const native = await loadNativeInterventionDiagnosticState(db, attempt.id);
    if (!native) continue;
    const verdict = native.trusted ? native.effective.verdict.verdict : 'unsupported';
    const rating =
      verdict === 'unsupported'
        ? null
        : verdict === 'correct'
          ? 'good'
          : verdict === 'partial'
            ? 'hard'
            : 'again';
    const units = native.effective.row.unit_results.filter((unit) => unit.status === 'scored');
    return {
      review_event: { id: attempt.id, rating },
      judge: {
        route: 'evaluate_submission',
        coarse_outcome: verdict,
        confidence: 0, // Native candidate records assert no model confidence.
        feedback_md: native.trusted
          ? units.flatMap((unit) => (unit.feedback_md ? [unit.feedback_md] : [])).join('\n\n')
          : '本次作答已保存，当前评估尚不能用于诊断结论，等待复核。',
        suggested_rating: rating,
        judge_event_id: null,
        evaluation_id: native.effective.evaluation_id,
      },
    };
  }
  const candidates = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'review'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(50);

  for (const candidate of candidates) {
    const review = await getEventById(db, candidate.id);
    if (review?.correction_status.state !== 'active') continue;
    const parsedReview = ReviewOnQuestion.safeParse(review);
    if (!parsedReview.success) continue;
    const effective = await loadLatestTrustedInterventionDiagnosticVerdict(db, review.id);
    if (!effective) continue;
    const suggestedRating =
      effective.verdict === 'correct' ? 'good' : effective.verdict === 'partial' ? 'hard' : 'again';
    return {
      review_event: {
        id: review.id,
        rating: parsedReview.data.payload.fsrs_rating,
      },
      judge: {
        route: 'multimodal_direct',
        coarse_outcome: effective.verdict,
        confidence: effective.confidence,
        feedback_md:
          effective.feedbackMd ??
          parsedReview.data.payload.judge?.feedback_md ??
          (effective.verdict === 'correct'
            ? '回答正确。'
            : effective.verdict === 'partial'
              ? '回答部分正确。'
              : '回答不正确。'),
        suggested_rating: suggestedRating,
        judge_event_id: effective.event.id,
      },
    };
  }
  return null;
}

/** Practice-owned port for retiring a completed one-shot diagnostic card. */
export async function retireInterventionDiagnosticQuestion(
  tx: Tx,
  questionId: string,
  now: Date,
): Promise<boolean> {
  const cardRetired = await retireQuestionFsrsState(tx, questionId);
  const retired = await tx
    .update(question)
    .set({
      draft_status: 'draft',
      updated_at: now,
      version: sql`${question.version} + 1`,
    })
    .where(
      and(
        eq(question.id, questionId),
        eq(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
      ),
    )
    .returning({ id: question.id });
  return cardRetired || retired.length > 0;
}
