import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import { parseEvent } from './index';
import {
  JUDGE_OPERATIONAL_ACTIONS,
  type JudgeDispositionPayload,
  JudgeOperationalEvent,
  type JudgeOwnership,
  type JudgeRunCoordinate,
} from './judge-operational-events';

const at = '2026-10-09T00:00:00.000Z';
const owner = {
  incarnation: 'b5ae67a2-9976-4abd-a537-dbcfbbf3a8f8',
  epoch: 2,
  backend: 'dbos',
} satisfies z.input<typeof JudgeOwnership>;
const digest = canonicalHash({
  answer: '原始作答\n'.repeat(180),
  units: ['equation', 'elimination', 'units'],
  evidence: { equations: ['v+c=18', 'v-c=12'], ambiguity: 'water speed or boat speed' },
});
const coordinate = {
  coordinate: 'native',
  run_id: 'frozen-multiunit-run',
  pending_id: 'evt_pending_frozen-multiunit-run',
  pending_digest: digest,
} satisfies z.input<typeof JudgeRunCoordinate>;
const envelope = {
  actor_kind: 'system',
  actor_ref: 'judge:operational',
  outcome: null,
  task_run_id: null,
  cost_micro_usd: null,
} satisfies Pick<
  z.input<typeof JudgeOperationalEvent>,
  'actor_kind' | 'actor_ref' | 'outcome' | 'task_run_id' | 'cost_micro_usd'
>;
const runEnvelope = {
  ...envelope,
  subject_kind: 'event',
  subject_id: coordinate.pending_id,
  caused_by_event_id: coordinate.pending_id,
} satisfies Pick<
  z.input<typeof JudgeOperationalEvent>,
  'actor_kind' | 'actor_ref' | 'outcome' | 'subject_kind' | 'subject_id' | 'caused_by_event_id'
>;
const familyEnvelope = {
  ...envelope,
  subject_kind: 'durable_family',
  subject_id: 'judge_run',
  caused_by_event_id: null,
} satisfies Pick<
  Extract<
    z.input<typeof JudgeOperationalEvent>,
    { action: 'experimental:judge_family_transition' }
  >,
  'actor_kind' | 'actor_ref' | 'outcome' | 'subject_kind' | 'subject_id' | 'caused_by_event_id'
>;
type Fixture = { name: string; value: z.input<typeof JudgeOperationalEvent> };
const runFixtures = [
  {
    name: 'execution binding',
    value: {
      ...runEnvelope,
      action: 'experimental:judge_execution_binding',
      payload: {
        ...coordinate,
        version: 1,
        evaluation_group_id: 'group-frozen',
        submission_id: 'submission-original',
        execution_key: 'native:submission-original:1',
        member_submission_ids: ['submission-original', 'submission-second'],
        input_digest: digest,
        intent_digest: digest,
        attempt: 1,
        admission_snapshot: {
          current_revision_id: null,
          generation: 3,
          state: 'admitted',
          suspended: false,
          withdrawn: false,
        },
        execution_policy: {
          version: 1,
          paid_retry: 'none',
          evaluation: { low_confidence_threshold: 0.8 },
        },
      },
    },
  },
  {
    name: 'delivery reservation',
    value: {
      ...runEnvelope,
      action: 'experimental:judge_delivery_reserved',
      payload: {
        ...coordinate,
        version: 1,
        slot: 2,
        ownership: owner,
        delivery_id: 'dbos:frozen-multiunit-run:2',
        reserved_at: at,
      },
    },
  },
  {
    name: 'delivery send',
    value: {
      ...runEnvelope,
      action: 'experimental:judge_delivery_send',
      payload: {
        ...coordinate,
        version: 1,
        reservation_id: 'evt_reserved_2',
        send_no: 2,
        ownership: owner,
        gate_checked_at: at,
        authorization_version: 1,
        authorization_digest: digest,
      },
    },
  },
  {
    name: 'delivery rejection',
    value: {
      ...runEnvelope,
      action: 'experimental:judge_delivery_rejected',
      payload: {
        ...coordinate,
        version: 1,
        send_id: 'evt_send_2',
        reason: 'producer_fenced',
        observed_at: at,
        evidence_digest: digest,
      },
    },
  },
  {
    name: 'delivery acceptance',
    value: {
      ...runEnvelope,
      action: 'experimental:judge_delivery_accepted',
      payload: {
        ...coordinate,
        version: 1,
        reservation_id: 'evt_reserved_2',
        ownership: owner,
        delivery_id: 'dbos:frozen-multiunit-run:2',
        accepted_send_id: 'evt_send_2',
        evidence: 'enqueue_ack',
        observed_at: at,
      },
    },
  },
  {
    name: 'delivery started',
    value: {
      ...runEnvelope,
      action: 'experimental:judge_delivery_started',
      payload: {
        ...coordinate,
        version: 1,
        reservation_id: 'evt_reserved_2',
        ownership: owner,
        started_at: at,
      },
    },
  },
] satisfies Fixture[];
const disposition = {
  version: 1,
  kind: 'manual',
  reason: 'explicit_disposal',
  actor_ref: 'operator:fixture',
  decided_at: at,
  observed_ownership: owner,
  evidence_refs: ['sealed-inventory', 'operator-decision'],
  evidence_digest: digest,
} satisfies Pick<
  z.input<typeof JudgeDispositionPayload>,
  | 'version'
  | 'kind'
  | 'reason'
  | 'actor_ref'
  | 'decided_at'
  | 'observed_ownership'
  | 'evidence_refs'
  | 'evidence_digest'
>;
const nullableCauseFixtures = [
  {
    name: 'native disposition',
    value: {
      ...runEnvelope,
      action: 'experimental:judge_disposition',
      payload: { ...coordinate, ...disposition },
    },
  },
  {
    name: 'legacy disposition',
    value: {
      ...familyEnvelope,
      action: 'experimental:judge_disposition',
      payload: {
        ...disposition,
        coordinate: 'legacy_task',
        backend: 'pg-boss',
        task_id: 'legacy-obligation',
        payload_digest: digest,
      },
    },
  },
  {
    name: 'native ownership',
    value: {
      ...runEnvelope,
      action: 'experimental:judge_ownership',
      payload: {
        ...coordinate,
        version: 1,
        from: null,
        to: owner,
        submitted_at: at,
        source_digest: digest,
        mapped_deliveries: [
          { slot: 0, delivery_id: 'legacy-original' },
          { slot: 2, delivery_id: 'recovery-2' },
        ],
        recovery_history: { kind: 'known', accepted_recovery_ids: ['recovery-1', 'recovery-2'] },
        evidence_refs: ['sealed-inventory', 'original-pending'],
      },
    },
  },
  {
    name: 'legacy ownership',
    value: {
      ...familyEnvelope,
      action: 'experimental:judge_ownership',
      payload: {
        coordinate: 'legacy_task',
        version: 1,
        backend: 'pg-boss',
        task_id: 'legacy-obligation',
        payload_digest: digest,
        to: owner,
        evidence_refs: ['sealed-inventory'],
      },
    },
  },
  {
    name: 'family transition',
    value: {
      ...familyEnvelope,
      action: 'experimental:judge_family_transition',
      payload: {
        version: 1,
        incarnation: owner.incarnation,
        prior_phase: 'draining-pg-boss',
        next_phase: 'dbos',
        prior_epoch: 1,
        next_epoch: 2,
        actor_ref: 'operator:fixture',
        evidence_refs: ['sealed-inventory', 'quiescence-receipt'],
        evidence_digest: digest,
        recorded_at: at,
      },
    },
  },
  {
    name: 'reconcile observation',
    value: {
      ...familyEnvelope,
      action: 'experimental:judge_reconcile_observation',
      payload: {
        version: 1,
        tick_id: 'judge-reconcile:2026-10-09T00:00:00.000Z',
        ownership: owner,
        sequence: 2,
        admission: 'admitted',
        pending_ids: [coordinate.pending_id, 'evt_pending_second'],
        cursor: { created_at: at, id: 'evt_pending_second' },
        recorded_at: at,
      },
    },
  },
] satisfies Fixture[];
const fixtures = [...runFixtures, ...nullableCauseFixtures];

// Matches the read-only prepareEventInsert parse projection, including its null normalization.
function prepareEventInsertInput(value: z.input<typeof JudgeOperationalEvent>) {
  return {
    actor_kind: value.actor_kind,
    actor_ref: value.actor_ref,
    action: value.action,
    subject_kind: value.subject_kind,
    subject_id: value.subject_id,
    outcome: value.outcome,
    payload: value.payload,
    caused_by_event_id: value.caused_by_event_id ?? undefined,
    task_run_id: value.task_run_id ?? undefined,
    cost_micro_usd: value.cost_micro_usd ?? undefined,
  };
}

describe('operational receipt envelope at the canonical event boundary', () => {
  it('covers every reserved operational action', () => {
    expect([...new Set(fixtures.map(({ value }) => value.action))].sort()).toEqual(
      [...JUDGE_OPERATIONAL_ACTIONS].sort(),
    );
  });

  it.each(fixtures)(
    'parses the real insert projection for $name without changing identity',
    ({ value }) => {
      const parsed = JudgeOperationalEvent.parse(value);
      const normalized = parseEvent(prepareEventInsertInput(value));
      expect(normalized).toEqual(parsed);
      expect(canonicalHash(normalized)).toBe(canonicalHash(parsed));
      expect(normalized).toMatchObject({
        actor_ref: 'judge:operational',
        action: value.action,
        payload: value.payload,
        task_run_id: null,
        cost_micro_usd: null,
      });
      expect(JudgeOperationalEvent.parse(normalized)).toEqual(normalized);
    },
  );

  it.each(nullableCauseFixtures)(
    'canonicalizes null, undefined and missing cause for $name',
    ({ value }) => {
      const {
        caused_by_event_id: _cause,
        task_run_id: _task,
        cost_micro_usd: _cost,
        ...missing
      } = value;
      const stored = JudgeOperationalEvent.parse({ ...value, caused_by_event_id: null });
      for (const input of [
        missing,
        {
          ...missing,
          caused_by_event_id: undefined,
          task_run_id: undefined,
          cost_micro_usd: undefined,
        },
        { ...missing, caused_by_event_id: null, task_run_id: null, cost_micro_usd: null },
      ]) {
        expect(JudgeOperationalEvent.parse(input)).toEqual(stored);
        expect(parseEvent(input)).toEqual(stored);
        expect(canonicalHash(parseEvent(input))).toBe(canonicalHash(stored));
      }
      expect(stored.caused_by_event_id).toBeNull();
    },
  );

  it.each(runFixtures)('keeps the exact nonempty cause required for $name', ({ value }) => {
    expect(parseEvent(prepareEventInsertInput(value))).toMatchObject({
      caused_by_event_id: coordinate.pending_id,
    });
    const { caused_by_event_id: _cause, ...missing } = value;
    for (const input of [
      missing,
      ...[null, undefined, '', 17].map((cause) => ({
        ...value,
        caused_by_event_id: cause,
      })),
    ]) {
      expect(JudgeOperationalEvent.safeParse(input).success).toBe(false);
      expect(() => parseEvent(input)).toThrow();
    }
  });

  it.each(
    nullableCauseFixtures.filter(
      ({ value }) =>
        value.action === 'experimental:judge_family_transition' ||
        value.action === 'experimental:judge_reconcile_observation',
    ),
  )('rejects an unrelated nonnull family cause for $name', ({ value }) => {
    for (const caused_by_event_id of ['evt_unrelated', '', 17]) {
      const input = { ...value, caused_by_event_id };
      expect(JudgeOperationalEvent.safeParse(input).success).toBe(false);
      expect(() => parseEvent(input)).toThrow();
    }
  });

  it.each(nullableCauseFixtures.filter(({ value }) => value.subject_kind === 'event'))(
    'preserves a supplied cause for the nullable $name contract',
    ({ value }) => {
      if (value.subject_kind !== 'event') throw new Error('native receipt fixture');
      const input = { ...value, caused_by_event_id: coordinate.pending_id };
      expect(parseEvent(prepareEventInsertInput(input))).toEqual(
        JudgeOperationalEvent.parse(input),
      );
      expect(JudgeOperationalEvent.parse(input).caused_by_event_id).toBe(coordinate.pending_id);
      expect(canonicalHash(JudgeOperationalEvent.parse(input))).not.toBe(
        canonicalHash(JudgeOperationalEvent.parse({ ...input, caused_by_event_id: null })),
      );
    },
  );

  it.each(fixtures)('keeps task, cost, outcome and payload constraints for $name', ({ value }) => {
    const malformed = [
      { ...value, task_run_id: 'forged-provider-run' },
      { ...value, cost_micro_usd: 0 },
      { ...value, cost_micro_usd: 12345 },
      { ...value, outcome: 'success' },
      { ...value, payload: { run_id: coordinate.run_id } },
      { ...value, payload: { ...value.payload, version: 2 } },
      { ...value, payload: { ...value.payload, arbitrary: 'not-allowlisted' } },
    ];
    for (const input of malformed) {
      expect(JudgeOperationalEvent.safeParse(input).success).toBe(false);
      expect(() => parseEvent(input)).toThrow();
    }
  });
});
