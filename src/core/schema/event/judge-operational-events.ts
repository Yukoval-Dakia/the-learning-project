import { z } from 'zod';
import { EvaluationAdmissionSnapshot, EvaluationExecutionPolicy } from '../assessment';

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().datetime();
const ordinal = z.number().int().nonnegative().safe();
export const JudgeBackend = z.enum(['pg-boss', 'dbos']);
export const JudgePhase = z.enum(['pg-boss', 'draining-pg-boss', 'dbos', 'draining-dbos']);
export const JudgeOwnership = z
  .object({ incarnation: z.uuid(), epoch: ordinal, backend: JudgeBackend })
  .strict();
export const JudgeControl = z.object({
  id: z.literal(1),
  incarnation: z.uuid(),
  epoch: ordinal,
  phase: JudgePhase,
  phase_changed_at: z.date(),
  transition_event_id: id.nullable(),
});
export const JudgeExecutionPolicy = z
  .object({
    version: z.literal(1),
    paid_retry: z.literal('none'),
    evaluation: EvaluationExecutionPolicy,
  })
  .strict();
export const JudgeRunCoordinate = z
  .object({
    coordinate: z.literal('native'),
    run_id: id,
    pending_id: id,
    pending_digest: digest,
  })
  .strict();
const coordinate = JudgeRunCoordinate.shape;
const version = z.literal(1);
export const JudgeBindingPayload = z
  .object({
    ...coordinate,
    version,
    evaluation_group_id: id,
    submission_id: id,
    execution_key: id,
    member_submission_ids: z.array(id).min(1),
    input_digest: digest,
    intent_digest: id,
    attempt: z.number().int().positive().safe(),
    admission_snapshot: EvaluationAdmissionSnapshot.nullable(),
    execution_policy: JudgeExecutionPolicy,
  })
  .strict();
export const JudgeReservationPayload = z
  .object({
    ...coordinate,
    version,
    slot: z.number().int().min(0).max(2),
    ownership: JudgeOwnership,
    delivery_id: id,
    reserved_at: at,
  })
  .strict();
export const JudgeSendPayload = z
  .object({
    ...coordinate,
    version,
    reservation_id: id,
    send_no: z.number().int().positive().safe(),
    ownership: JudgeOwnership,
    gate_checked_at: at,
    authorization_version: z.literal(1),
    authorization_digest: digest,
  })
  .strict();
export const JudgeRejectionPayload = z
  .object({
    ...coordinate,
    version,
    send_id: id,
    reason: z.enum(['producer_fenced', 'validation_rejected']),
    observed_at: at,
    evidence_digest: digest,
  })
  .strict();
export const JudgeAcceptancePayload = z
  .object({
    ...coordinate,
    version,
    reservation_id: id,
    ownership: JudgeOwnership,
    delivery_id: id,
    accepted_send_id: id.nullable(),
    evidence: z.enum(['enqueue_ack', 'worker_entry', 'authoritative_lookup', 'legacy_mapping']),
    observed_at: at,
  })
  .strict()
  .refine(
    (p) =>
      p.accepted_send_id !== null ||
      p.evidence === 'authoritative_lookup' ||
      p.evidence === 'legacy_mapping',
  );
export const JudgeStartedPayload = z
  .object({
    ...coordinate,
    version,
    reservation_id: id,
    ownership: JudgeOwnership,
    started_at: at,
  })
  .strict();
export const JudgeDispositionReason = z.enum([
  'provider_unknown',
  'invalid_receipt',
  'input_conflict',
  'terminal_delivery',
  'recovery_exhausted',
  'recovery_history_unknown',
  'historical_unknown',
  'explicit_disposal',
]);
const disposition = {
  version,
  kind: z.literal('manual'),
  reason: JudgeDispositionReason,
  actor_ref: id,
  decided_at: at,
  observed_ownership: JudgeOwnership,
  evidence_refs: z.array(id).min(1),
  evidence_digest: digest,
};
export const JudgeDispositionPayload = z.discriminatedUnion('coordinate', [
  z.object({ ...coordinate, ...disposition }).strict(),
  z
    .object({
      coordinate: z.literal('legacy_task'),
      backend: JudgeBackend,
      task_id: id,
      payload_digest: digest,
      ...disposition,
    })
    .strict(),
]);
export const JudgeRecoveryHistory = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('known'), accepted_recovery_ids: z.array(id).max(2) }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);
export const JudgeOwnershipPayload = z.discriminatedUnion('coordinate', [
  z
    .object({
      ...coordinate,
      version,
      from: JudgeOwnership.nullable(),
      to: JudgeOwnership,
      submitted_at: at,
      source_digest: digest,
      mapped_deliveries: z
        .array(z.object({ slot: z.number().int().min(0).max(2), delivery_id: id }).strict())
        .max(3),
      recovery_history: JudgeRecoveryHistory,
      evidence_refs: z.array(id).min(1),
    })
    .strict(),
  z
    .object({
      coordinate: z.literal('legacy_task'),
      version,
      backend: JudgeBackend,
      task_id: id,
      payload_digest: digest,
      to: JudgeOwnership,
      evidence_refs: z.array(id).min(1),
    })
    .strict(),
]);
export const JudgeTransitionPayload = z
  .object({
    version,
    incarnation: z.uuid(),
    prior_phase: JudgePhase,
    next_phase: JudgePhase,
    prior_epoch: ordinal,
    next_epoch: ordinal,
    actor_ref: id,
    evidence_refs: z.array(id).min(1),
    evidence_digest: digest,
    recorded_at: at,
  })
  .strict()
  .refine((p) => p.next_epoch === p.prior_epoch + 1);
export const JudgeReconcileObservationPayload = z
  .object({
    version,
    tick_id: id,
    ownership: JudgeOwnership,
    sequence: ordinal,
    admission: z.enum(['admitted', 'fenced']),
    pending_ids: z.array(id).max(200),
    cursor: z.object({ created_at: at, id }).nullable(),
    recorded_at: at,
  })
  .strict();

const envelope = {
  actor_kind: z.literal('system'),
  actor_ref: z.literal('judge:operational'),
  outcome: z.null(),
  // Kernel parse projections use undefined; stored receipt identity uses null.
  task_run_id: z.null().default(null).optional(),
  cost_micro_usd: z.null().default(null).optional(),
};
const runEnvelope = {
  ...envelope,
  subject_kind: z.literal('event'),
  subject_id: id,
  caused_by_event_id: id,
};
export const JudgeOperationalEvent = z.discriminatedUnion('action', [
  z.object({
    ...runEnvelope,
    action: z.literal('experimental:judge_execution_binding'),
    payload: JudgeBindingPayload,
  }),
  z.object({
    ...runEnvelope,
    action: z.literal('experimental:judge_delivery_reserved'),
    payload: JudgeReservationPayload,
  }),
  z.object({
    ...runEnvelope,
    action: z.literal('experimental:judge_delivery_send'),
    payload: JudgeSendPayload,
  }),
  z.object({
    ...runEnvelope,
    action: z.literal('experimental:judge_delivery_rejected'),
    payload: JudgeRejectionPayload,
  }),
  z.object({
    ...runEnvelope,
    action: z.literal('experimental:judge_delivery_accepted'),
    payload: JudgeAcceptancePayload,
  }),
  z.object({
    ...runEnvelope,
    action: z.literal('experimental:judge_delivery_started'),
    payload: JudgeStartedPayload,
  }),
  z.object({
    ...envelope,
    subject_kind: z.enum(['event', 'durable_family']),
    subject_id: id,
    caused_by_event_id: id.nullable().default(null),
    action: z.literal('experimental:judge_disposition'),
    payload: JudgeDispositionPayload,
  }),
  z.object({
    ...envelope,
    subject_kind: z.enum(['event', 'durable_family']),
    subject_id: id,
    caused_by_event_id: id.nullable().default(null),
    action: z.literal('experimental:judge_ownership'),
    payload: JudgeOwnershipPayload,
  }),
  z.object({
    ...envelope,
    subject_kind: z.literal('durable_family'),
    subject_id: z.literal('judge_run'),
    caused_by_event_id: z.null().default(null),
    action: z.literal('experimental:judge_family_transition'),
    payload: JudgeTransitionPayload,
  }),
  z.object({
    ...envelope,
    subject_kind: z.literal('durable_family'),
    subject_id: z.literal('judge_run'),
    caused_by_event_id: z.null().default(null),
    action: z.literal('experimental:judge_reconcile_observation'),
    payload: JudgeReconcileObservationPayload,
  }),
]);
export type JudgeOperationalEventT = z.infer<typeof JudgeOperationalEvent>;
export type JudgeBinding = z.infer<typeof JudgeBindingPayload>;
export type JudgeReservation = z.infer<typeof JudgeReservationPayload>;
export type JudgeSend = z.infer<typeof JudgeSendPayload>;
export type JudgeOwner = z.infer<typeof JudgeOwnership>;
export type JudgeControlT = z.infer<typeof JudgeControl>;
export type JudgeDisposition = z.infer<typeof JudgeDispositionPayload>;
export type JudgeOwnershipReceipt = z.infer<typeof JudgeOwnershipPayload>;
export const JUDGE_OPERATIONAL_ACTIONS = JudgeOperationalEvent.options.map(
  (s) => s.shape.action.value,
);
export const JudgeWorkflowInput = z
  .object({
    version,
    run_id: id,
    pending_id: id,
    pending_digest: digest,
    reservation_id: id,
    delivery_id: id,
    ownership: JudgeOwnership,
  })
  .strict();
export type JudgeWorkflowInputT = z.infer<typeof JudgeWorkflowInput>;
