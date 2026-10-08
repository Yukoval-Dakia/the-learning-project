import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import {
  EvaluationAdmissionSnapshot,
  type ModelExecutorRequest,
  ModelUnitOutcome,
} from '@/core/schema/assessment';
import {
  type JudgeBinding,
  JudgeBindingPayload,
  JudgeControl,
  type JudgeControlT,
  type JudgeDispositionReason,
  JudgeOperationalEvent,
  type JudgeOperationalEventT,
  type JudgeOwner,
  type JudgeReservation,
  JudgeWorkflowInput,
  type JudgeWorkflowInputT,
} from '@/core/schema/event/judge-operational-events';
import type { JudgePendingAttemptPayloadT } from '@/core/schema/event/judge-pending-events';
import type { Db, Tx } from '@/db/client';
import {
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  judge_run_control,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { judgeDeliveryInput, judgeLegacyJobId } from '@/server/durable/judge-client';
import {
  judgeAcceptanceId,
  judgeBindingId,
  judgeDispositionId,
  judgeReceiptId,
  judgeReservationId,
  judgeSendId,
  judgeWorkflowId,
  sameJudgeOwner,
} from './judge-operational-state';
import { readJudgeRunPermanent } from './judge-run-observation';

export type JudgeExecution = JudgeWorkflowInputT;
export class JudgeRunClosedError extends Error {
  constructor(
    readonly kind: 'completed' | 'disposed' | 'unmapped',
    readonly runId: string,
  ) {
    super(`Judge run ${runId} is ${kind}`);
  }
}
export class JudgeReceiptConflict extends Error {}
export async function lockJudgeRun(tx: Tx, runId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
}
export async function readJudgeControl(
  database: Db | Tx,
  lock?: 'share' | 'update',
): Promise<JudgeControlT> {
  const query = database.select().from(judge_run_control).where(eq(judge_run_control.id, 1));
  const [row] = lock ? await query.for(lock) : await query;
  return JudgeControl.parse(row);
}
export function judgeOwner(control: JudgeControlT): JudgeOwner {
  return {
    incarnation: control.incarnation,
    epoch: control.epoch,
    backend: control.phase.endsWith('dbos') ? 'dbos' : 'pg-boss',
  };
}
export function judgeCoordinate(pendingId: string, payload: JudgePendingAttemptPayloadT) {
  return {
    coordinate: 'native' as const,
    run_id: payload.run_id,
    pending_id: pendingId,
    pending_digest: canonicalHash(payload),
  };
}
/** writeEvent ignores duplicate IDs. Always parse and compare the stored immutable identity. */
export async function writeJudgeReceipt(
  tx: Tx,
  id: string,
  receipt: JudgeOperationalEventT,
  at = new Date(),
) {
  const valid = JudgeOperationalEvent.parse(receipt);
  const [existing] = await tx.select().from(event).where(eq(event.id, id));
  if (existing) {
    const stored = JudgeOperationalEvent.parse(existing);
    if (
      canonicalHash(stored) !== canonicalHash(valid) ||
      existing.ingest_at === null ||
      existing.affected_scopes.length ||
      existing.outcome !== null ||
      existing.cost_micro_usd !== null
    )
      throw new JudgeReceiptConflict(`Immutable judge receipt conflict ${id}`);
    return { id, value: stored, createdAt: existing.created_at };
  }
  await writeEvent(tx, {
    id,
    ...valid,
    created_at: at,
    ingest_at: at,
    affected_scopes: [],
    cost_micro_usd: null,
    task_run_id: null,
  });
  const [saved] = await tx.select().from(event).where(eq(event.id, id));
  if (!saved || canonicalHash(JudgeOperationalEvent.parse(saved)) !== canonicalHash(valid))
    throw new JudgeReceiptConflict(`Judge receipt insert conflict ${id}`);
  return { id, value: valid, createdAt: saved.created_at };
}
export function judgeRunEnvelope(pendingId: string) {
  return {
    actor_kind: 'system' as const,
    actor_ref: 'judge:operational' as const,
    subject_kind: 'event' as const,
    subject_id: pendingId,
    caused_by_event_id: pendingId,
    outcome: null,
    task_run_id: null,
    cost_micro_usd: null,
  };
}

export async function rejectJudgeSend(
  tx: Tx,
  reservation: JudgeReservation,
  sendId: string,
  reason: 'producer_fenced' | 'validation_rejected',
) {
  const id = judgeReceiptId('reject', [sendId]);
  const [prior] = await tx.select().from(event).where(eq(event.id, id));
  const saved = prior ? JudgeOperationalEvent.parse(prior) : null;
  if (saved && saved.action !== 'experimental:judge_delivery_rejected')
    throw new JudgeReceiptConflict('Rejected send identity conflict');
  return writeJudgeReceipt(tx, id, {
    ...judgeRunEnvelope(reservation.pending_id),
    action: 'experimental:judge_delivery_rejected',
    payload: {
      ...judgeCoordinateFields(reservation),
      version: 1,
      send_id: sendId,
      reason,
      observed_at: saved?.payload.observed_at ?? new Date().toISOString(),
      evidence_digest: canonicalHash({ sendId, reason }),
    },
  });
}
export async function reserveInitialJudgeDelivery(
  tx: Tx,
  pendingId: string,
  payload: JudgePendingAttemptPayloadT,
  control: JudgeControlT,
  at: Date,
) {
  if (payload.caller !== 'native_assessment')
    throw new JudgeReceiptConflict('Legacy input cannot obtain native execution authority');
  const coordinate = judgeCoordinate(pendingId, payload),
    ownership = judgeOwner(control);
  await writeJudgeReceipt(
    tx,
    judgeReceiptId('owner', [payload.run_id, control.incarnation, control.epoch]),
    {
      ...judgeRunEnvelope(pendingId),
      action: 'experimental:judge_ownership',
      payload: {
        ...coordinate,
        version: 1,
        from: null,
        to: ownership,
        submitted_at: payload.submit.submitted_at,
        source_digest: coordinate.pending_digest,
        mapped_deliveries: [],
        recovery_history: { kind: 'known', accepted_recovery_ids: [] },
        evidence_refs: [pendingId],
      },
    },
    at,
  );
  return reserveJudgeDelivery(tx, pendingId, payload, ownership, 0, at);
}
export async function reserveJudgeDelivery(
  tx: Tx,
  pendingId: string,
  payload: JudgePendingAttemptPayloadT,
  ownership: JudgeOwner,
  slot: number,
  at: Date,
) {
  const id = judgeReservationId(payload.run_id, slot);
  const [existing] = await tx.select().from(event).where(eq(event.id, id));
  if (existing) {
    const value = JudgeOperationalEvent.parse(existing);
    if (
      value.action !== 'experimental:judge_delivery_reserved' ||
      value.payload.pending_digest !== canonicalHash(payload) ||
      !sameJudgeOwner(value.payload.ownership, ownership)
    )
      throw new JudgeReceiptConflict('Reservation is already bound to another owner/input');
    return value.payload;
  }
  const reservation: JudgeReservation = {
    ...judgeCoordinate(pendingId, payload),
    version: 1,
    slot,
    ownership,
    delivery_id:
      ownership.backend === 'dbos'
        ? judgeWorkflowId(payload.run_id, slot)
        : judgeLegacyJobId(payload.run_id, slot),
    reserved_at: at.toISOString(),
  };
  await writeJudgeReceipt(
    tx,
    id,
    {
      ...judgeRunEnvelope(pendingId),
      action: 'experimental:judge_delivery_reserved',
      payload: reservation,
    },
    at,
  );
  return reservation;
}
export async function authorizeJudgeSend(tx: Tx, reservation: JudgeReservation, at: Date) {
  const reservationId = judgeReservationId(reservation.run_id, reservation.slot);
  const rows = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:judge_delivery_send'),
        sql`${event.payload}->>'reservation_id' = ${reservationId}`,
      ),
    );
  const sequence = z
    .array(z.object({ send_no: z.number().int().positive() }))
    .parse(rows.map((r) => r.payload));
  const sendNo = Math.max(0, ...sequence.map((r) => r.send_no)) + 1;
  const sendId = judgeSendId(reservationId, sendNo);
  await writeJudgeReceipt(
    tx,
    sendId,
    {
      ...judgeRunEnvelope(reservation.pending_id),
      action: 'experimental:judge_delivery_send',
      payload: {
        ...judgeCoordinateFields(reservation),
        version: 1,
        reservation_id: reservationId,
        send_no: sendNo,
        ownership: reservation.ownership,
        gate_checked_at: at.toISOString(),
        authorization_version: 1,
        authorization_digest: canonicalHash(judgeDeliveryInput(reservation)),
      },
    },
    at,
  );
  return sendId;
}
function judgeCoordinateFields(reservation: JudgeReservation) {
  return {
    coordinate: reservation.coordinate,
    run_id: reservation.run_id,
    pending_id: reservation.pending_id,
    pending_digest: reservation.pending_digest,
  };
}
export async function acceptJudgeDelivery(
  tx: Tx,
  reservation: JudgeReservation,
  sendId: string | null,
  evidence: 'enqueue_ack' | 'worker_entry' | 'authoritative_lookup' | 'legacy_mapping',
  at = new Date(),
) {
  const reservationId = judgeReservationId(reservation.run_id, reservation.slot),
    id = judgeAcceptanceId(reservationId);
  const [saved] = await tx.select().from(event).where(eq(event.id, id));
  if (saved) {
    const value = JudgeOperationalEvent.parse(saved);
    if (
      value.action !== 'experimental:judge_delivery_accepted' ||
      value.payload.delivery_id !== reservation.delivery_id ||
      value.payload.pending_digest !== reservation.pending_digest ||
      !sameJudgeOwner(value.payload.ownership, reservation.ownership)
    )
      throw new JudgeReceiptConflict('Acceptance replay identity mismatch');
    return;
  }
  await writeJudgeReceipt(
    tx,
    id,
    {
      ...judgeRunEnvelope(reservation.pending_id),
      action: 'experimental:judge_delivery_accepted',
      payload: {
        ...judgeCoordinateFields(reservation),
        version: 1,
        reservation_id: reservationId,
        ownership: reservation.ownership,
        delivery_id: reservation.delivery_id,
        accepted_send_id: sendId,
        evidence,
        observed_at: at.toISOString(),
      },
    },
    at,
  );
}
export async function assertJudgeRunOpen(tx: Tx, execution: JudgeExecution) {
  const valid = JudgeWorkflowInput.parse(execution);
  await lockJudgeRun(tx, valid.run_id);
  const state = await readJudgeRunPermanent(tx, valid.run_id);
  if (state.kind === 'resolved') return { kind: 'completed' as const };
  if (state.kind === 'manual') return { kind: 'disposed' as const };
  if (
    state.kind !== 'pending' ||
    state.pending.id !== valid.pending_id ||
    canonicalHash(state.pending.payload) !== valid.pending_digest
  )
    return { kind: 'unmapped' as const };
  const delivery = state.operational.deliveries.find(
    (d) => d.reservationId === valid.reservation_id,
  );
  if (
    !delivery ||
    canonicalHash(judgeDeliveryInput(delivery.reservation)) !== canonicalHash(valid) ||
    (!sameJudgeOwner(delivery.reservation.ownership, state.operational.ownership.to) &&
      !state.operational.ownership.mapped_deliveries.some(
        (d) => d.delivery_id === valid.delivery_id && d.slot === delivery.reservation.slot,
      ))
  )
    return { kind: 'unmapped' as const };
  return { kind: 'open' as const, state, delivery };
}
export async function requireJudgeRunOpen(tx: Tx, execution: JudgeExecution) {
  const result = await assertJudgeRunOpen(tx, execution);
  if (result.kind !== 'open') throw new JudgeRunClosedError(result.kind, execution.run_id);
  return result;
}
export async function startJudgeDelivery(database: Db, execution: JudgeExecution) {
  const valid = JudgeWorkflowInput.parse(execution);
  return database.transaction(async (tx) => {
    await readJudgeControl(tx, 'share');
    await lockJudgeRun(tx, valid.run_id);
    const [row] = await tx.select().from(event).where(eq(event.id, valid.reservation_id));
    const reserved = JudgeOperationalEvent.parse(row);
    if (
      reserved.action !== 'experimental:judge_delivery_reserved' ||
      canonicalHash(judgeDeliveryInput(reserved.payload)) !== canonicalHash(valid)
    )
      throw new JudgeReceiptConflict('Worker input differs from retained reservation');
    const rows = await tx
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:judge_delivery_send'),
          sql`${event.payload}->>'reservation_id' = ${valid.reservation_id}`,
        ),
      );
    const sends = rows
      .map((r) => ({ id: r.id, value: JudgeOperationalEvent.parse(r) }))
      .flatMap((r) =>
        r.value.action === 'experimental:judge_delivery_send'
          ? [{ id: r.id, payload: r.value.payload }]
          : [],
      );
    const rejected = await tx
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:judge_delivery_rejected'),
          sql`${event.payload}->>'run_id' = ${valid.run_id}`,
        ),
      );
    const rejectedIds = new Set(rejected.map((r) => r.payload.send_id));
    const send = sends
      .filter(
        (s) =>
          !rejectedIds.has(s.id) &&
          s.payload.authorization_digest === canonicalHash(valid) &&
          sameJudgeOwner(s.payload.ownership, valid.ownership),
      )
      .sort((a, b) => b.payload.send_no - a.payload.send_no)[0];
    if (!send)
      throw new JudgeReceiptConflict('Worker entry has no valid retained send authorization');
    // Acceptance is factual even if manual disposition won while the producer was sending.
    await acceptJudgeDelivery(tx, reserved.payload, send.id, 'worker_entry');
    const id = judgeReceiptId('start', [valid.reservation_id]);
    const [existing] = await tx.select().from(event).where(eq(event.id, id));
    if (existing) {
      const saved = JudgeOperationalEvent.parse(existing);
      if (
        saved.action !== 'experimental:judge_delivery_started' ||
        saved.payload.reservation_id !== valid.reservation_id ||
        !sameJudgeOwner(saved.payload.ownership, valid.ownership)
      )
        throw new JudgeReceiptConflict('Started receipt replay conflict');
    } else
      await writeJudgeReceipt(tx, id, {
        ...judgeRunEnvelope(valid.pending_id),
        action: 'experimental:judge_delivery_started',
        payload: {
          ...judgeCoordinateFields(reserved.payload),
          version: 1,
          reservation_id: valid.reservation_id,
          ownership: valid.ownership,
          started_at: new Date().toISOString(),
        },
      });
    return (await assertJudgeRunOpen(tx, valid)).kind;
  });
}
export async function bindJudgeExecution(
  tx: Tx,
  execution: JudgeExecution,
  input: Omit<JudgeBinding, 'version' | 'coordinate' | 'run_id' | 'pending_id' | 'pending_digest'>,
) {
  const { state } = await requireJudgeRunOpen(tx, execution);
  const wanted = JudgeBindingPayload.parse({
    ...judgeCoordinate(state.pending.id, state.pending.payload),
    version: 1,
    ...input,
  });
  const prior = state.operational.binding;
  if (prior) {
    if (
      prior.input_digest !== wanted.input_digest ||
      prior.intent_digest !== wanted.intent_digest ||
      prior.execution_key !== wanted.execution_key ||
      prior.submission_id !== wanted.submission_id ||
      canonicalHash(prior.execution_policy) !== canonicalHash(wanted.execution_policy)
    )
      throw new JudgeReceiptConflict('Bound judge input/policy differs');
    return prior;
  }
  await writeJudgeReceipt(tx, judgeBindingId(input.evaluation_group_id, input.execution_key), {
    ...judgeRunEnvelope(execution.pending_id),
    action: 'experimental:judge_execution_binding',
    payload: wanted,
  });
  return wanted;
}
/** This is a transaction callback before C. It performs no I/O and takes no group/learning lock after R. */
export async function fenceJudgeUnitClaim(
  tx: Tx,
  execution: JudgeExecution,
  request: ModelExecutorRequest,
): Promise<string | null> {
  const { state } = await requireJudgeRunOpen(tx, execution),
    binding = state.operational.binding;
  if (
    !binding ||
    binding.attempt !== request.attempt ||
    binding.evaluation_group_id !== request.evaluation_group_id ||
    binding.submission_id !== request.submission_id ||
    canonicalHash([...binding.member_submission_ids].sort()) !==
      canonicalHash([...(request.submission_ids ?? [request.submission_id])].sort())
  )
    throw new JudgeReceiptConflict('Model claim differs from immutable binding');
  const [collision] = await tx
    .select({ id: evaluation.evaluation_id })
    .from(evaluation)
    .where(
      and(
        eq(evaluation.submission_id, request.submission_id),
        eq(evaluation.attempt, request.attempt),
      ),
    );
  if (collision) return 'bound candidate slot is occupied; automatic repurchase forbidden';
  const pending = state.pending.payload;
  if (pending.caller !== 'native_assessment')
    throw new JudgeReceiptConflict('Native claim requires native pending input');
  const [head] = await tx
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, request.evaluation_group_id));
  if (
    (head?.effective_evaluation_id ?? null) !==
      pending.submit.expected_head.expected_effective_id ||
    (head?.generation ?? 0) !== pending.submit.expected_head.expected_generation
  )
    return 'accepted effective head changed before a fresh model claim';
  const [submission] = await tx
    .select()
    .from(assessment_submission)
    .where(eq(assessment_submission.submission_id, request.submission_id));
  const [revision] = submission
    ? await tx
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, submission.revision_id))
    : [];
  if (revision?.revision_id !== request.revision_id)
    throw new JudgeReceiptConflict('Claim revision differs from frozen submission');
  const [admission] = revision
    ? await tx
        .select({
          current_revision_id: question_group_lifecycle.current_revision_id,
          generation: question_group_lifecycle.scoring_admission_generation,
          state: question_group_lifecycle.scoring_admission_state,
          suspended: question_group_lifecycle.suspended,
          withdrawn: question_group_lifecycle.withdrawn,
        })
        .from(question_group_lifecycle)
        .where(eq(question_group_lifecycle.group_id, revision.group_id))
    : [];
  if (
    canonicalHash(EvaluationAdmissionSnapshot.nullable().parse(admission ?? null)) !==
    canonicalHash(binding.admission_snapshot)
  )
    return 'frozen scoring admission changed before a fresh model claim';
  const claims = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_model_claim'),
        sql`${event.payload}->>'submission_id' = ${request.submission_id}`,
        sql`${event.payload}->>'attempt' = ${String(request.attempt)}`,
      ),
    );
  for (const claim of claims) {
    const [result] = await tx
      .select()
      .from(event)
      .where(eq(event.id, claim.id.replace('evt_model_claim_', 'evt_model_result_')));
    const outcome = ModelUnitOutcome.safeParse(result?.payload.outcome);
    if (
      !result ||
      result.caused_by_event_id !== claim.id ||
      result.payload.input_digest !== claim.payload.input_digest ||
      !outcome.success ||
      outcome.data.kind === 'pending'
    )
      return 'a prior unit has an unknown or held result; further fresh claims are forbidden';
  }
  return null;
}
export async function disposeJudgeRun(
  database: Db,
  runId: string,
  input: {
    reason: z.infer<typeof JudgeDispositionReason>;
    actorRef: string;
    evidenceRefs: string[];
    evidenceDigest: string;
    at?: Date;
  },
) {
  return database.transaction(async (tx) => {
    await lockJudgeRun(tx, runId);
    const state = await readJudgeRunPermanent(tx, runId);
    if (state.kind === 'resolved') return { kind: 'already_completed' as const };
    if (state.kind === 'manual')
      return { kind: 'disposed' as const, disposition: state.disposition };
    if (state.kind !== 'pending' && !(state.kind === 'unmapped' && state.pending))
      throw new JudgeRunClosedError('unmapped', runId);
    const pending = state.pending;
    if (!pending) throw new JudgeRunClosedError('unmapped', runId);
    const at = input.at ?? new Date();
    const payload = {
      ...judgeCoordinate(pending.id, pending.payload),
      version: 1 as const,
      kind: 'manual' as const,
      reason: input.reason,
      actor_ref: input.actorRef,
      decided_at: at.toISOString(),
      observed_ownership:
        state.kind === 'pending'
          ? state.operational.ownership.to
          : judgeOwner(await readJudgeControl(tx)),
      evidence_refs: input.evidenceRefs,
      evidence_digest: input.evidenceDigest,
    };
    const [existing] = await tx
      .select()
      .from(event)
      .where(eq(event.id, judgeDispositionId(runId)));
    if (existing) {
      const saved = JudgeOperationalEvent.parse(existing);
      if (
        saved.action !== 'experimental:judge_disposition' ||
        saved.payload.coordinate !== 'native' ||
        saved.payload.pending_digest !== payload.pending_digest
      )
        throw new JudgeReceiptConflict('Manual disposition conflict');
      return { kind: 'disposed' as const, disposition: saved.payload };
    }
    await writeJudgeReceipt(
      tx,
      judgeDispositionId(runId),
      { ...judgeRunEnvelope(pending.id), action: 'experimental:judge_disposition', payload },
      at,
    );
    return { kind: 'disposed' as const, disposition: payload };
  });
}
