// Settlement delivery owns the durable rerank effect; the answer remains committed
// independently. Delivery outcome and partition mutations share one transaction.
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  event,
  event_subscription_delivery,
  practice_stream_item,
} from '@/db/schema';
import {
  lockPracticeStreamCarryAdmission,
  lockPracticeStreamPartition,
} from '@/kernel/locks/practice-stream';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import {
  liveAppliedSettlements,
  loadSettlementEvents,
} from '@/kernel/read-models/assessment-settlements';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';
import {
  type SelectionObservationInput,
  recordSelectionObservation,
} from './selection-observations';
import { buildSeededSelectionRng } from './selection-seed';
import { reRankAfterAnswer } from './stream-rerank';
import { resolveSelectionPolicy } from './stream-store';

export const SETTLEMENT_RERANK_SUBSCRIBER = 'practice.settlement-stream-rerank';

export async function handleSettlementRerankDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
): Promise<EventSubscriptionOutcome> {
  if (delivery.subscriberId !== SETTLEMENT_RERANK_SUBSCRIBER || delivery.subscriberVersion !== 1)
    throw new Error('unexpected settlement rerank subscription identity');
  const observations: SelectionObservationInput[] = [];
  const outcome = await db.transaction(async (tx): Promise<EventSubscriptionOutcome> => {
    const key = and(
      eq(event_subscription_delivery.subscriber_id, delivery.subscriberId),
      eq(event_subscription_delivery.subscriber_version, delivery.subscriberVersion),
      eq(event_subscription_delivery.source_event_id, delivery.sourceEventId),
    );
    const [stored] = await tx.select().from(event_subscription_delivery).where(key).for('update');
    if (!stored) throw new Error('settlement rerank delivery has not been discovered');
    // Framework acknowledgement is a later transaction. A crash in between must
    // replay this outcome, never the sampler. The framework persists the same detail.
    if (stored.outcome?.stream_rerank_completed === true) {
      const detail = stored.outcome;
      return detail.status === 'skipped'
        ? { status: 'skipped', reason: String(detail.reason), detail }
        : { status: 'succeeded', detail };
    }
    if (stored.status !== 'claimed') throw new Error('settlement rerank delivery is not claimed');
    const finish = async (result: EventSubscriptionOutcome): Promise<EventSubscriptionOutcome> => {
      const detail = {
        ...result.detail,
        stream_rerank_completed: true,
        status: result.status,
        ...(result.status === 'skipped' ? { reason: result.reason } : {}),
      };
      await tx.update(event_subscription_delivery).set({ outcome: detail }).where(key);
      return { ...result, detail };
    };
    if (resolveSelectionPolicy().policy !== 'softmax_mfi')
      return finish({ status: 'skipped', reason: 'legacy selection policy' });
    const [source] = await tx.select().from(event).where(eq(event.id, delivery.sourceEventId));
    if (source?.action !== 'experimental:assessment_settlement')
      return finish({ status: 'skipped', reason: 'not a settlement receipt' });
    // Canonical liveness also removes superseded/withdrawn receipts. Replay members
    // are reconstruction, not another answer that gets a new random selection.
    const member = liveAppliedSettlements(await loadSettlementEvents(tx, source.created_at)).find(
      (row) => row.id === source.id,
    );
    const effects = source.payload.effects;
    const thetaApplied =
      effects &&
      typeof effects === 'object' &&
      'theta_applied' in effects &&
      Array.isArray(effects.theta_applied)
        ? effects.theta_applied
        : [];
    if (
      !member ||
      member.fsrsOnly ||
      !member.inputs.theta.applied ||
      source.payload.replay_of != null
    )
      return finish({ status: 'skipped', reason: 'no newly effective theta settlement' });
    const affectedKnowledgeIds = member.inputs.theta.knowledgeIds.filter(
      (id) => thetaApplied.includes(id) && member.subjects.has(`knowledge:${id}`),
    );
    if (affectedKnowledgeIds.length === 0)
      return finish({ status: 'skipped', reason: 'no committed affected knowledge' });
    const [binding] = await tx
      .select({ issuanceId: assessment_issuance.issuance_id })
      .from(assessment_submission)
      .innerJoin(
        assessment_issuance,
        eq(assessment_issuance.issuance_id, assessment_submission.issuance_id),
      )
      .where(eq(assessment_submission.submission_id, member.inputs.submissionId));
    const issuanceId = binding?.issuanceId;
    if (!issuanceId?.startsWith('iss_stream_'))
      return finish({ status: 'skipped', reason: 'settlement is not stream-issued' });
    const streamItemId = issuanceId.slice('iss_stream_'.length);
    const [attempt] = await tx
      .select()
      .from(event)
      .where(eq(event.id, assessmentAttemptEventId(member.inputs.submissionId)));
    if (attempt?.payload.issuance_id !== binding.issuanceId || attempt.subject_kind !== 'question')
      return finish({ status: 'skipped', reason: 'sealed stream attempt unavailable' });
    // Carry keeps the issuance-bound row id while changing its date. Admission
    // prevents a move between locating that row and locking its actual partition.
    await lockPracticeStreamCarryAdmission(tx);
    const [slot] = await tx
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.id, streamItemId));
    if (slot?.item_kind !== 'question' || slot.ref_id !== attempt.subject_id)
      return finish({ status: 'skipped', reason: 'issued stream row no longer exists' });
    await lockPracticeStreamPartition(tx, slot.date, slot.session_id);
    const [current] = await tx
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.id, streamItemId));
    if (!current || current.date !== slot.date || current.session_id !== slot.session_id)
      throw new Error('issued stream partition changed; retry delivery');
    const added = await reRankAfterAnswer(tx, {
      date: current.date,
      sessionId: current.session_id,
      answeredQuestionId: current.ref_id,
      affectedKnowledgeIds,
      observations,
      rng: buildSeededSelectionRng(current.date, 'rerank', source.id),
    });
    return finish({
      status: 'succeeded',
      detail: {
        settlement_event_id: source.id,
        stream_item_id: streamItemId,
        date: current.date,
        session_id: current.session_id,
        added,
      },
    });
  });
  // Telemetry cannot roll back the answer or the completed rerank effect.
  for (const observation of observations) {
    try {
      await recordSelectionObservation(db, observation);
    } catch (error) {
      console.error('[settlement-rerank] observation failed after commit', error);
    }
  }
  return outcome;
}

export const buildSettlementRerankSubscriber: EventSubscriptionHandlerFactory =
  (db: Db) => (delivery) =>
    handleSettlementRerankDelivery(db, delivery);
