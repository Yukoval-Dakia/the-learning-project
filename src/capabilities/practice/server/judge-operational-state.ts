import { canonicalHash } from '@/core/migration/canonical';
import type {
  JudgeBinding,
  JudgeControlT,
  JudgeDisposition,
  JudgeOperationalEventT,
  JudgeOwner,
  JudgeOwnershipReceipt,
  JudgeReservation,
  JudgeSend,
} from '@/core/schema/event/judge-operational-events';

export function judgeReceiptId(kind: string, coordinates: readonly unknown[]): string {
  return `evt_judge_${kind}_${canonicalHash(coordinates)}`;
}
export const judgeBindingId = (group: string, key: string) =>
  judgeReceiptId('binding', [group, key]);
export const judgeReservationId = (run: string, slot: number) =>
  judgeReceiptId('delivery', [run, slot]);
export const judgeSendId = (reservation: string, sendNo: number) =>
  judgeReceiptId('send', [reservation, sendNo]);
export const judgeAcceptanceId = (reservation: string) => judgeReceiptId('accept', [reservation]);
export const judgeDispositionId = (run: string) => judgeReceiptId('disposition', [run]);
export const judgeWorkflowId = (run: string, slot: number) =>
  `judge-run-v1:${run}:delivery:${slot}`;
export const sameJudgeOwner = (a: JudgeOwner, b: JudgeOwner) =>
  canonicalHash(a) === canonicalHash(b);

export type SavedJudgeReceipt = { id: string; value: JudgeOperationalEventT; createdAt: Date };
export type NativeJudgeDisposition = Extract<JudgeDisposition, { coordinate: 'native' }>;
export type NativeJudgeOwnership = Extract<JudgeOwnershipReceipt, { coordinate: 'native' }>;
export type JudgeDelivery =
  | {
      kind: 'reserved_unsent';
      reservation: JudgeReservation;
      reservationId: string;
      sends: JudgeSend[];
    }
  | { kind: 'rejected'; reservation: JudgeReservation; reservationId: string; sends: JudgeSend[] }
  | {
      kind: 'send_unknown';
      reservation: JudgeReservation;
      reservationId: string;
      sends: JudgeSend[];
    }
  | {
      kind: 'accepted' | 'started';
      reservation: JudgeReservation;
      reservationId: string;
      sends: JudgeSend[];
    };
export type JudgeOperationalState =
  | { kind: 'corrupt'; reason: string }
  | { kind: 'unmapped'; reason: 'ownership_unknown' }
  | { kind: 'disposed'; disposition: NativeJudgeDisposition }
  | {
      kind: 'mapped';
      ownership: NativeJudgeOwnership;
      binding: JudgeBinding | null;
      disposition: NativeJudgeDisposition | null;
      deliveries: JudgeDelivery[];
    };

/** The reducer consumes validated permanent receipts. Notification and engine success cannot grant authority. */
export function reduceJudgeOperationalState(args: {
  runId: string;
  pendingId: string;
  pendingDigest: string;
  control: JudgeControlT;
  receipts: SavedJudgeReceipt[];
}): JudgeOperationalState {
  const native = args.receipts.filter(
    (r) => 'coordinate' in r.value.payload && r.value.payload.coordinate === 'native',
  );
  for (const r of native) {
    const p = r.value.payload;
    if (
      !('run_id' in p) ||
      p.run_id !== args.runId ||
      p.pending_id !== args.pendingId ||
      p.pending_digest !== args.pendingDigest ||
      r.value.subject_kind !== 'event' ||
      r.value.subject_id !== args.pendingId ||
      r.value.caused_by_event_id !== args.pendingId
    )
      return { kind: 'corrupt', reason: 'operational coordinate mismatch' };
  }
  const owners = native.flatMap((r) =>
    r.value.action === 'experimental:judge_ownership' && r.value.payload.coordinate === 'native'
      ? [r.value.payload]
      : [],
  );
  const ownership = owners
    .filter(
      (p) => p.to.incarnation === args.control.incarnation && p.to.epoch <= args.control.epoch,
    )
    .sort((a, b) => b.to.epoch - a.to.epoch)[0];
  const bindings = native.flatMap((r) =>
    r.value.action === 'experimental:judge_execution_binding' ? [r.value.payload] : [],
  );
  const dispositions = native.flatMap((r) =>
    r.value.action === 'experimental:judge_disposition' && r.value.payload.coordinate === 'native'
      ? [r.value.payload]
      : [],
  );
  if (bindings.length > 1 || dispositions.length > 1)
    return { kind: 'corrupt', reason: 'duplicate immutable authority' };
  if (dispositions[0]) return { kind: 'disposed', disposition: dispositions[0] };
  if (!ownership) return { kind: 'unmapped', reason: 'ownership_unknown' };
  const backend = args.control.phase.endsWith('dbos') ? 'dbos' : 'pg-boss';
  if (!dispositions.length && ownership.to.backend !== backend)
    return { kind: 'unmapped', reason: 'ownership_unknown' };
  const reservations = native.flatMap((r) =>
    r.value.action === 'experimental:judge_delivery_reserved'
      ? [{ id: r.id, payload: r.value.payload }]
      : [],
  );
  if (
    new Set(reservations.map((r) => r.payload.slot)).size !== reservations.length ||
    reservations.length > 3
  )
    return { kind: 'corrupt', reason: 'duplicate reservation slot' };
  const deliveries: JudgeDelivery[] = [];
  for (const r of reservations.sort((a, b) => a.payload.slot - b.payload.slot)) {
    if (r.id !== judgeReservationId(args.runId, r.payload.slot))
      return { kind: 'corrupt', reason: 'reservation identity mismatch' };
    const sends = native.flatMap((s) =>
      s.value.action === 'experimental:judge_delivery_send' &&
      s.value.payload.reservation_id === r.id
        ? [{ id: s.id, payload: s.value.payload }]
        : [],
    );
    if (
      new Set(sends.map((s) => s.payload.send_no)).size !== sends.length ||
      sends.some(
        (s) =>
          s.id !== judgeSendId(r.id, s.payload.send_no) ||
          !sameJudgeOwner(s.payload.ownership, r.payload.ownership),
      )
    )
      return { kind: 'corrupt', reason: 'send identity mismatch' };
    const acceptances = native.flatMap((s) =>
      s.value.action === 'experimental:judge_delivery_accepted' &&
      s.value.payload.reservation_id === r.id
        ? [s.value.payload]
        : [],
    );
    if (
      acceptances.length > 1 ||
      acceptances.some(
        (a) =>
          a.delivery_id !== r.payload.delivery_id ||
          !sameJudgeOwner(a.ownership, r.payload.ownership) ||
          (a.accepted_send_id !== null && !sends.some((s) => s.id === a.accepted_send_id)),
      )
    )
      return { kind: 'corrupt', reason: 'acceptance identity mismatch' };
    const started = native.some(
      (s) =>
        s.value.action === 'experimental:judge_delivery_started' &&
        s.value.payload.reservation_id === r.id &&
        sameJudgeOwner(s.value.payload.ownership, r.payload.ownership),
    );
    if (started && !acceptances.length)
      return { kind: 'corrupt', reason: 'start without acceptance' };
    const rejected = new Set(
      native.flatMap((s) =>
        s.value.action === 'experimental:judge_delivery_rejected' ? [s.value.payload.send_id] : [],
      ),
    );
    const kind = acceptances.length
      ? started
        ? 'started'
        : 'accepted'
      : sends.some((s) => !rejected.has(s.id))
        ? 'send_unknown'
        : sends.length
          ? 'rejected'
          : 'reserved_unsent';
    deliveries.push({
      kind,
      reservation: r.payload,
      reservationId: r.id,
      sends: sends.map((s) => s.payload).sort((a, b) => a.send_no - b.send_no),
    });
  }
  const reservationIds = new Set(reservations.map((r) => r.id));
  if (
    native.some(
      (r) =>
        'reservation_id' in r.value.payload && !reservationIds.has(r.value.payload.reservation_id),
    )
  )
    return { kind: 'corrupt', reason: 'orphan delivery receipt' };
  return {
    kind: 'mapped',
    ownership,
    binding: bindings[0] ?? null,
    disposition: dispositions[0] ?? null,
    deliveries,
  };
}

export const JUDGE_RECOVERY_AGE_MS = 7 * 86400_000;
export function judgeRecoveryCapacity(args: {
  state: Extract<JudgeOperationalState, { kind: 'mapped' }>;
  submittedAt: Date;
  now: Date;
}) {
  if (args.state.disposition)
    return { kind: 'manual' as const, reason: args.state.disposition.reason };
  if (args.state.ownership.recovery_history.kind === 'unknown')
    return { kind: 'manual' as const, reason: 'recovery_history_unknown' as const };
  if (args.state.deliveries.some((d) => d.kind === 'send_unknown'))
    return { kind: 'unknown' as const };
  const accepted = new Set([
    ...args.state.ownership.recovery_history.accepted_recovery_ids,
    ...args.state.deliveries
      .filter((d) => d.reservation.slot > 0 && (d.kind === 'accepted' || d.kind === 'started'))
      .map((d) => d.reservation.delivery_id),
  ]);
  if (
    args.now.getTime() - args.submittedAt.getTime() >= JUDGE_RECOVERY_AGE_MS ||
    accepted.size >= 2
  )
    return { kind: 'manual' as const, reason: 'recovery_exhausted' as const };
  const slot = Math.max(
    accepted.size + 1,
    ...args.state.deliveries.map((d) => d.reservation.slot + 1),
  );
  return slot > 2
    ? { kind: 'manual' as const, reason: 'recovery_exhausted' as const }
    : { kind: 'available' as const, slot };
}
