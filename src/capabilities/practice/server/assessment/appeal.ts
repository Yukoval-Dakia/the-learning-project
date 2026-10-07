import { eq, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import { ActivateEvaluationIntent, EvaluationProvenance } from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { evaluation, evaluation_effective_head, event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  activateSubmissionCandidate,
  createFormalModelExecutor,
} from '../judge/evaluate-submission';
import { evaluateAttempt } from '../judge/evaluation-authority';

export async function createNativeAppeal(
  database: Db,
  input: { evaluation_id: string; reason_md?: string; idempotency_key?: string },
) {
  const reason = input.reason_md ?? '';
  const appealId = `evt_native_appeal_${canonicalHash({
    evaluation_id: input.evaluation_id,
    key: input.idempotency_key ?? canonicalHash(reason),
  })}`;
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${appealId}))`);
    const [existing] = await tx.select().from(event).where(eq(event.id, appealId)).limit(1);
    if (existing) {
      if (existing.payload.reason_md !== reason)
        throw new ApiError('appeal_conflict', 'appeal key already has a different reason', 409);
      return appealId;
    }
    const [original] = await tx
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, input.evaluation_id))
      .limit(1);
    if (!original) throw new ApiError('not_found', 'evaluation not found', 404);
    if (original.status !== 'completed' || original.provenance?.source !== 'automatic') {
      throw new ApiError('not_appealable', 'a completed automatic evaluation is required', 422);
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('assessment-evaluation-group'), hashtext(${original.evaluation_group_id}))`,
    );
    const [head] = await tx
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, original.evaluation_group_id))
      .limit(1);
    if (!head || head.effective_evaluation_id !== original.evaluation_id) {
      throw new ApiError(
        'stale_head',
        'appeal must identify the current effective evaluation',
        409,
      );
    }
    await writeEvent(tx, {
      id: appealId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:appeal_request',
      subject_kind: 'evaluation',
      subject_id: original.evaluation_id,
      outcome: null,
      payload: {
        reason_md: reason,
        evaluation_group_id: original.evaluation_group_id,
        expected_effective_id: original.evaluation_id,
        expected_generation: head.generation,
      },
    });
    return appealId;
  });
}

export async function rejudgeNativeAppeal(database: Db, appeal: typeof event.$inferSelect) {
  const resolutionId = `evt_native_resolution_${canonicalHash(appeal.id)}`;
  const record = async (tx: Db | Tx, disposition: string, evaluationId?: string) => {
    // Used with the activation transaction, or alone for an explicit held result.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${resolutionId}))`);
    const [existing] = await tx
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, resolutionId));
    if (existing) return;
    await writeEvent(tx, {
      id: resolutionId,
      actor_kind: 'system',
      actor_ref: 'assessment:appeal',
      action: 'experimental:assessment_appeal_resolution',
      subject_kind: 'evaluation',
      subject_id: appeal.subject_id,
      outcome: null,
      caused_by_event_id: appeal.id,
      payload: { disposition, ...(evaluationId ? { evaluation_id: evaluationId } : {}) },
    });
  };
  const hold = async (reason: string, evaluationId?: string) => {
    await database.transaction((tx) => record(tx, reason, evaluationId));
    return { status: 'held' as const, appeal_event_id: appeal.id, reason };
  };
  const [original] = await database
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, appeal.subject_id))
    .limit(1);
  const provenance = EvaluationProvenance.safeParse(original?.provenance);
  if (
    !original ||
    !provenance.success ||
    !provenance.data.input_snapshot ||
    provenance.data.source !== 'automatic'
  )
    return hold('frozen_input_unavailable');
  const intent = ActivateEvaluationIntent.safeParse({
    evaluation_id: original.evaluation_id,
    expected_effective_id: appeal.payload.expected_effective_id,
    expected_generation: appeal.payload.expected_generation,
  });
  if (!intent.success) return hold('activation_intent_unavailable');
  const [head] = await database
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, original.evaluation_group_id))
    .limit(1);
  if (
    head?.effective_evaluation_id !== intent.data.expected_effective_id ||
    head.generation !== intent.data.expected_generation
  )
    return hold('stale_head');
  const candidate = await evaluateAttempt({
    db: database,
    entry: 'appeal_rejudge',
    contract: {
      submission_id: original.submission_id,
      evaluation_group_id: original.evaluation_group_id,
      expected_submission_ids: provenance.data.input_snapshot.member_submission_ids,
      evaluation_key: `appeal:${appeal.id}`,
      provenance: {
        source: 'automatic',
        assisted: provenance.data.assisted,
        review_context: {
          appeal_event_id: appeal.id,
          prior_evaluation_id: original.evaluation_id,
          reason_md: typeof appeal.payload.reason_md === 'string' ? appeal.payload.reason_md : '',
        },
      },
      model_executor: createFormalModelExecutor(database),
    },
  });
  const candidateId = candidate.evaluation.record.evaluation_id;
  if (
    candidate.evaluation.record.status !== 'completed' ||
    candidate.result.coarse_outcome === 'unsupported'
  )
    return hold('review_required', candidateId);
  const activation = await activateSubmissionCandidate(
    database,
    { ...intent.data, evaluation_id: candidateId },
    {
      actorRef: 'assessment:appeal',
      record: (tx) => record(tx, 'effective', candidateId),
    },
  );
  if (activation.status !== 'activated' && activation.status !== 'already_effective')
    return hold(activation.status, candidateId);
  return {
    status: 'reassessed' as const,
    appeal_event_id: appeal.id,
    evaluation_id: candidateId,
    effect: activation.effect,
  };
}
