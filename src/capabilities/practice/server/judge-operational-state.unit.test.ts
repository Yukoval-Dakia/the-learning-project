import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@/core/migration/canonical';
import {
  JudgeControl,
  JudgeOperationalEvent,
  JudgeReservationPayload,
} from '@/core/schema/event/judge-operational-events';
import {
  type SavedJudgeReceipt,
  judgeAcceptanceId,
  judgeDispositionId,
  judgeReceiptId,
  judgeRecoveryCapacity,
  judgeReservationId,
  judgeSendId,
  judgeWorkflowId,
  reduceJudgeOperationalState,
} from './judge-operational-state';

const at = new Date('2026-10-09T00:00:00Z');
const owner = {
  incarnation: 'b5ae67a2-9976-4abd-a537-dbcfbbf3a8f8',
  epoch: 2,
  backend: 'dbos' as const,
};
const control = JudgeControl.parse({
  id: 1,
  ...owner,
  phase: 'dbos',
  phase_changed_at: at,
  transition_event_id: null,
});
const coordinate = {
  coordinate: 'native' as const,
  run_id: 'frozen-multiunit-run',
  pending_id: 'evt_pending_frozen-multiunit-run',
  pending_digest: canonicalHash({
    original: '原始作答\n'.repeat(180),
    units: ['equation', 'elimination', 'units'],
    nested: { evidence: ['v+c=18', 'v-c=12'], ambiguity: 'water speed or boat speed' },
  }),
};
const envelope = {
  actor_kind: 'system' as const,
  actor_ref: 'judge:operational' as const,
  subject_kind: 'event' as const,
  subject_id: coordinate.pending_id,
  caused_by_event_id: coordinate.pending_id,
  outcome: null,
};
function saved(id: string, value: unknown): SavedJudgeReceipt {
  return { id, value: JudgeOperationalEvent.parse(value), createdAt: at };
}
function ownership(history: string[] | 'unknown' = []) {
  return saved(judgeReceiptId('owner', [coordinate.run_id, owner.incarnation, owner.epoch]), {
    ...envelope,
    action: 'experimental:judge_ownership',
    payload: {
      ...coordinate,
      version: 1,
      from: null,
      to: owner,
      submitted_at: at.toISOString(),
      source_digest: coordinate.pending_digest,
      mapped_deliveries: [],
      recovery_history:
        history === 'unknown'
          ? { kind: 'unknown' }
          : { kind: 'known', accepted_recovery_ids: history },
      evidence_refs: ['sealed-source'],
    },
  });
}
function delivery(slot: number, kind: 'unsent' | 'unknown' | 'accepted' | 'started' = 'accepted') {
  const reservation = JudgeReservationPayload.parse({
    ...coordinate,
    version: 1,
    slot,
    ownership: owner,
    delivery_id: judgeWorkflowId(coordinate.run_id, slot),
    reserved_at: at.toISOString(),
  });
  const id = judgeReservationId(coordinate.run_id, slot),
    sendId = judgeSendId(id, 1);
  const rows = [
    saved(id, {
      ...envelope,
      action: 'experimental:judge_delivery_reserved',
      payload: reservation,
    }),
  ];
  if (kind !== 'unsent')
    rows.push(
      saved(sendId, {
        ...envelope,
        action: 'experimental:judge_delivery_send',
        payload: {
          ...coordinate,
          version: 1,
          reservation_id: id,
          send_no: 1,
          ownership: owner,
          gate_checked_at: at.toISOString(),
          authorization_version: 1,
          authorization_digest: canonicalHash({ slot }),
        },
      }),
    );
  if (kind === 'accepted' || kind === 'started')
    rows.push(
      saved(judgeAcceptanceId(id), {
        ...envelope,
        action: 'experimental:judge_delivery_accepted',
        payload: {
          ...coordinate,
          version: 1,
          reservation_id: id,
          ownership: owner,
          delivery_id: reservation.delivery_id,
          accepted_send_id: sendId,
          evidence: 'enqueue_ack',
          observed_at: at.toISOString(),
        },
      }),
    );
  if (kind === 'started')
    rows.push(
      saved(judgeReceiptId('start', [id]), {
        ...envelope,
        action: 'experimental:judge_delivery_started',
        payload: {
          ...coordinate,
          version: 1,
          reservation_id: id,
          ownership: owner,
          started_at: at.toISOString(),
        },
      }),
    );
  return rows;
}
const reduce = (receipts: SavedJudgeReceipt[], nextControl = control) =>
  reduceJudgeOperationalState({
    runId: coordinate.run_id,
    pendingId: coordinate.pending_id,
    pendingDigest: coordinate.pending_digest,
    control: nextControl,
    receipts,
  });
describe('permanent judge delivery authority', () => {
  it('distinguishes reserved, uncertain, accepted and started without notification evidence', () => {
    for (const [input, kind] of [
      ['unsent', 'reserved_unsent'],
      ['unknown', 'send_unknown'],
      ['accepted', 'accepted'],
      ['started', 'started'],
    ] as const) {
      const state = reduce([ownership(), ...delivery(0, input)]);
      expect(state.kind).toBe('mapped');
      if (state.kind === 'mapped') expect(state.deliveries[0]?.kind).toBe(kind);
    }
  });
  it('does not clear an older unknown when a later authorized send is rejected', () => {
    const rows = delivery(1, 'unknown'),
      id = judgeReservationId(coordinate.run_id, 1),
      first = rows[1];
    if (first?.value.action !== 'experimental:judge_delivery_send') throw new Error('fixture send');
    rows.push(
      saved(judgeSendId(id, 2), {
        ...first.value,
        payload: { ...first.value.payload, send_no: 2 },
      }),
    );
    rows.push(
      saved(judgeReceiptId('reject', [judgeSendId(id, 2)]), {
        ...envelope,
        action: 'experimental:judge_delivery_rejected',
        payload: {
          ...coordinate,
          version: 1,
          send_id: judgeSendId(id, 2),
          reason: 'producer_fenced',
          observed_at: at.toISOString(),
          evidence_digest: canonicalHash('fenced'),
        },
      }),
    );
    const state = reduce([ownership(), ...rows]);
    if (state.kind !== 'mapped') throw new Error(state.kind);
    expect(state.deliveries[0]?.kind).toBe('send_unknown');
    expect(judgeRecoveryCapacity({ state, submittedAt: at, now: at })).toEqual({ kind: 'unknown' });
  });
  it('retains two accepted recovery deliveries and rejects a third after marker pruning', () => {
    const state = reduce([ownership(), ...delivery(0), ...delivery(1), ...delivery(2, 'started')]);
    if (state.kind !== 'mapped') throw new Error(state.kind);
    expect(judgeRecoveryCapacity({ state, submittedAt: at, now: at })).toEqual({
      kind: 'manual',
      reason: 'recovery_exhausted',
    });
    expect(state.deliveries.at(-1)?.kind).toBe('started');
  });
  it('stops new admission at exactly seven days without revoking a pre-boundary final delivery', () => {
    const state = reduce([ownership(), ...delivery(0), ...delivery(1)]);
    if (state.kind !== 'mapped') throw new Error(state.kind);
    expect(
      judgeRecoveryCapacity({
        state,
        submittedAt: at,
        now: new Date(at.getTime() + 7 * 86400_000 - 1),
      }),
    ).toEqual({ kind: 'available', slot: 2 });
    expect(
      judgeRecoveryCapacity({
        state,
        submittedAt: at,
        now: new Date(at.getTime() + 7 * 86400_000),
      }),
    ).toEqual({ kind: 'manual', reason: 'recovery_exhausted' });
    expect(state.deliveries.at(-1)?.kind).toBe('accepted');
  });
  it('never infers zero recovery history or execution permission from an archive', () => {
    const state = reduce([ownership('unknown'), ...delivery(0)]);
    if (state.kind !== 'mapped') throw new Error(state.kind);
    expect(judgeRecoveryCapacity({ state, submittedAt: at, now: at })).toEqual({
      kind: 'manual',
      reason: 'recovery_history_unknown',
    });
    expect(
      reduce([ownership(), ...delivery(0)], {
        ...control,
        incarnation: 'd6a62d80-c2ce-46be-8a8c-3b79e7ca6750',
      }),
    ).toEqual({ kind: 'unmapped', reason: 'ownership_unknown' });
  });
  it('manual disposition is visible even without executable ownership, and malformed coordinates fail closed', () => {
    const row = saved(judgeDispositionId(coordinate.run_id), {
      ...envelope,
      action: 'experimental:judge_disposition',
      payload: {
        ...coordinate,
        version: 1,
        kind: 'manual',
        reason: 'historical_unknown',
        actor_ref: 'operator',
        decided_at: at.toISOString(),
        observed_ownership: owner,
        evidence_refs: ['legacy-payload'],
        evidence_digest: canonicalHash('old'),
      },
    });
    expect(reduce([row]).kind).toBe('disposed');
    const wrong = saved(row.id, { ...row.value, subject_id: 'unrelated-original' });
    expect(reduce([wrong]).kind).toBe('corrupt');
  });
  it('rejects duplicate alternative reservations and orphan acceptance', () => {
    const rows = delivery(0);
    if (!rows[0]) throw new Error('fixture');
    expect(reduce([ownership(), ...rows, { ...rows[0], id: 'wrong-id' }]).kind).toBe('corrupt');
    expect(reduce([ownership(), ...rows.slice(1)]).kind).toBe('corrupt');
  });
});
