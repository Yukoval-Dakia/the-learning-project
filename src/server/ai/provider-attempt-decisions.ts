import type { ProviderRequestIdentity } from '@/core/schema/provider-attempt';

export interface AttemptState extends Record<string, unknown> {
  operation_id: string | null;
  attempt_kind: string | null;
  provider: string | null;
  model: string | null;
  lane_id: string | null;
  protocol: string | null;
  endpoint_class: string | null;
  caller: string | null;
  operation_kind: string | null;
  external_request_id: string | null;
  terminal_status: string | null;
  terminal_reason: string | null;
  wire_count: number | null;
  usage_json: unknown;
  cost_basis: string | null;
  cost_amount: number | null;
  cost_currency: string | null;
  cost_source: string | null;
  provider_start_reserved_at: Date | string | null;
  identity_fingerprint: string | null;
  admission_status: string | null;
  lease_owner: string | null;
  lease_live: boolean | null;
  deadline_matches: boolean | null;
}

/** Ordered guards: earlier identity/terminal facts take precedence over lease recovery. */
export function evaluateExistingAttempt(
  row: AttemptState | undefined,
  identity: ProviderRequestIdentity,
  identityFingerprint: string,
  deadlineElapsed: boolean,
  mode: 'off' | 'observe' | 'enforce',
) {
  if (!row) return null;
  if (row.identity_fingerprint !== null && row.identity_fingerprint !== identityFingerprint) {
    return 'identity_collision' as const;
  }
  if (
    row.operation_id !== null &&
    (row.operation_id !== identity.operationId ||
      row.attempt_kind !== identity.attemptKind ||
      row.provider !== identity.provider ||
      row.model !== identity.model ||
      row.lane_id !== identity.lane ||
      row.protocol !== identity.protocol ||
      row.endpoint_class !== identity.endpointClass ||
      row.caller !== identity.caller ||
      row.operation_kind !== identity.operationKind)
  ) {
    return 'identity_collision' as const;
  }

  if (
    row.terminal_status !== null ||
    row.admission_status === 'denied' ||
    row.admission_status === 'released' ||
    row.admission_status === 'lease_expired'
  ) {
    return 'terminal_reuse' as const;
  }
  if (row.admission_status !== null && row.deadline_matches !== true) {
    return 'deadline_mismatch' as const;
  }
  if (row.operation_id !== null && row.admission_status === null) {
    return 'recovery_required' as const;
  }
  if (
    identity.externalRequestId !== undefined &&
    row.external_request_id !== null &&
    row.external_request_id !== identity.externalRequestId
  ) {
    return 'external_request_id_conflict' as const;
  }
  if (row.lease_live === true && !(deadlineElapsed && mode === 'enforce')) {
    return 'active_duplicate' as const;
  }
  if (row.provider_start_reserved_at !== null) {
    return 'recovery_required' as const;
  }

  return null;
}
