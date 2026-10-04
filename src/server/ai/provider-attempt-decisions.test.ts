import { describe, expect, it } from 'vitest';
import { ProviderRequestIdentity } from '@/core/schema/provider-attempt';
import { type AttemptState, evaluateExistingAttempt } from './provider-attempt-decisions';

const identity = ProviderRequestIdentity.parse({
  attemptId: '00000000-0000-4000-8000-000000000107',
  operationId: '00000000-0000-4000-8000-000000000852',
  attemptKind: 'wire',
  provider: 'xiaomi',
  model: 'mimo-v2.5',
  lane: 'generation',
  protocol: 'openai-completions',
  endpointClass: 'chat-completions',
  caller: 'worker',
  operationKind: 'QuestionGenerateTask',
  externalRequestId: 'upstream-request/1076',
});
const hash = 'immutable-identity-and-operation-kind-fence';
const reservedAt = '2026-10-04T11:00:00.000Z';

function state(overrides: Partial<AttemptState> = {}): AttemptState {
  return {
    operation_id: identity.operationId,
    attempt_kind: identity.attemptKind,
    provider: identity.provider,
    model: identity.model,
    lane_id: identity.lane,
    protocol: identity.protocol,
    endpoint_class: identity.endpointClass,
    caller: identity.caller,
    operation_kind: identity.operationKind,
    external_request_id: identity.externalRequestId ?? null,
    terminal_status: null,
    terminal_reason: null,
    wire_count: null,
    usage_json: { basis: 'unknown', source: 'provider:no-usage', input: null, output: null },
    cost_basis: 'unknown',
    cost_amount: null,
    cost_currency: 'USD',
    cost_source: 'pricebook:no-entry',
    provider_start_reserved_at: null,
    identity_fingerprint: hash,
    admission_status: 'acquired',
    lease_owner: '00000000-0000-4000-8000-000000000777',
    lease_live: false,
    deadline_matches: true,
    ...overrides,
  };
}

const decide = (row: AttemptState | undefined) =>
  evaluateExistingAttempt(row, identity, hash, false, 'enforce');

describe('existing provider attempt decision precedence', () => {
  it('allows an absent row or an expired, unreserved attempt to reach admission checks', () => {
    expect(decide(undefined)).toBeNull();
    expect(decide(state())).toBeNull();
  });

  it.each([
    'operation_id',
    'attempt_kind',
    'provider',
    'model',
    'lane_id',
    'protocol',
    'endpoint_class',
    'caller',
    'operation_kind',
    'identity_fingerprint',
  ] as const)('rejects immutable %s drift before terminal/deadline/lease conflicts', (field) => {
    const row = state({
      [field]: 'different',
      terminal_status: 'succeeded',
      admission_status: 'released',
      deadline_matches: false,
      lease_live: true,
      provider_start_reserved_at: reservedAt,
      external_request_id: 'another-request',
    });
    expect(decide(row)).toBe('identity_collision');
  });

  it('still compares immutable fields when the joined admission fingerprint is absent', () => {
    expect(decide(state({ identity_fingerprint: null, model: 'other-model' }))).toBe(
      'identity_collision',
    );
  });

  it('accepts nullable model identity and admission-only rows without inventing an operation', () => {
    expect(
      evaluateExistingAttempt(
        state({ model: null }),
        { ...identity, model: null },
        hash,
        false,
        'enforce',
      ),
    ).toBeNull();
    expect(decide(state({ operation_id: null, model: null, provider: null }))).toBeNull();
  });

  it.each(['denied', 'released', 'lease_expired'])(
    'treats %s as terminal before deadline and lease guards',
    (admission_status) => {
      expect(
        decide(
          state({
            admission_status,
            deadline_matches: false,
            lease_live: true,
            external_request_id: 'another-request',
            provider_start_reserved_at: reservedAt,
          }),
        ),
      ).toBe('terminal_reuse');
    },
  );

  it('treats a terminal operation as terminal even when admission is missing', () => {
    expect(
      decide(
        state({
          terminal_status: 'unknown',
          admission_status: null,
          provider_start_reserved_at: reservedAt,
        }),
      ),
    ).toBe('terminal_reuse');
  });

  it.each([false, null])(
    'rejects nonmatching deadline %s before external id, lease, or recovery',
    (deadline_matches) => {
      expect(
        decide(
          state({
            deadline_matches,
            external_request_id: 'another-request',
            lease_live: true,
            provider_start_reserved_at: reservedAt,
          }),
        ),
      ).toBe('deadline_mismatch');
    },
  );

  it('requires recovery for an operation without admission before checking its external id', () => {
    expect(
      decide(
        state({
          admission_status: null,
          deadline_matches: null,
          external_request_id: 'another-request',
          lease_live: true,
        }),
      ),
    ).toBe('recovery_required');
  });

  it('rejects external id conflicts before a live or started attempt', () => {
    expect(
      decide(
        state({
          external_request_id: 'another-request',
          lease_live: true,
          provider_start_reserved_at: reservedAt,
        }),
      ),
    ).toBe('external_request_id_conflict');
  });

  it('allows a missing requested id or an unbound stored id', () => {
    const { externalRequestId: _externalRequestId, ...unboundIdentity } = identity;
    expect(
      evaluateExistingAttempt(
        state({ external_request_id: 'existing-request' }),
        unboundIdentity,
        hash,
        false,
        'enforce',
      ),
    ).toBeNull();
    expect(decide(state({ external_request_id: null }))).toBeNull();
  });

  it.each([
    ['enforce', false, 'active_duplicate'],
    ['enforce', true, 'recovery_required'],
    ['observe', false, 'active_duplicate'],
    ['observe', true, 'active_duplicate'],
    ['off', false, 'active_duplicate'],
    ['off', true, 'active_duplicate'],
  ] as const)(
    'resolves live started attempt with mode=%s elapsed=%s as %s',
    (mode, elapsed, expected) => {
      expect(
        evaluateExistingAttempt(
          state({ lease_live: true, provider_start_reserved_at: reservedAt }),
          identity,
          hash,
          elapsed,
          mode,
        ),
      ).toBe(expected);
    },
  );

  it('lets elapsed enforce reach durable deadline denial only when no start was reserved', () => {
    expect(
      evaluateExistingAttempt(state({ lease_live: true }), identity, hash, true, 'enforce'),
    ).toBeNull();
  });

  it.each([false, null])(
    'requires recovery for a started attempt with lease_live=%s',
    (lease_live) => {
      expect(decide(state({ lease_live, provider_start_reserved_at: reservedAt }))).toBe(
        'recovery_required',
      );
    },
  );
});
