import { createHash, randomUUID } from 'node:crypto';
// allow: SIZE_OK — one transactional state machine owns acquisition, fencing, external-ID CAS, and settlement.
import {
  ProviderAttemptTerminalEvidence,
  type ProviderAttemptTerminalEvidence as ProviderAttemptTerminalEvidenceT,
  ProviderAttemptUsageTruth,
  ProviderRequestIdentity,
  type ProviderRequestIdentity as ProviderRequestIdentityT,
} from '@/core/schema/provider-attempt';
import type { Db } from '@/db/client';
import { provider_attempt, provider_attempt_admission } from '@/db/schema';
import { sql } from 'drizzle-orm';
import type { ProviderAttemptAdmissionPolicy } from './provider-attempt-admission-config';

export type ProviderAttemptLifecycleMode = 'off' | 'observe' | 'enforce';
export type ProviderAttemptAdmission = 'off' | 'acquired' | 'would_deny' | 'untracked';
export type ProviderAttemptFinishResult = 'settled' | 'already_settled' | 'untracked';
export type ProviderAttemptLifecycleReason =
  | 'active_duplicate'
  | 'capacity_exhausted'
  | 'control_plane_unavailable'
  | 'deadline_elapsed'
  | 'deadline_mismatch'
  | 'external_request_id_conflict'
  | 'identity_collision'
  | 'lease_lost'
  | 'opaque_wire_count'
  | 'policy_mismatch'
  | 'recovery_required'
  | 'rate_exhausted'
  | 'terminal_conflict'
  | 'terminal_reuse';

export class ProviderAttemptLifecycleError extends Error {
  readonly reason: ProviderAttemptLifecycleReason;
  readonly attemptId: string;

  constructor(reason: ProviderAttemptLifecycleReason, attemptId: string, cause?: unknown) {
    super(`provider attempt ${reason}: ${attemptId}`, cause === undefined ? undefined : { cause });
    this.name = 'ProviderAttemptLifecycleError';
    this.reason = reason;
    this.attemptId = attemptId;
  }
}

export interface ProviderAttemptHandle {
  readonly admission: ProviderAttemptAdmission;
  reserveProviderStart(): Promise<void>;
  recordExternalRequestId(id: string): Promise<void>;
  finish(evidence: ProviderAttemptTerminalEvidenceT): Promise<ProviderAttemptFinishResult>;
}

export interface ProviderAttemptLifecycle {
  readonly identity: ProviderRequestIdentityT;
  acquire(): Promise<ProviderAttemptHandle>;
}

interface AttemptState extends Record<string, unknown> {
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

export const OBSERVE_WOULD_DENY_LEASE_MS = 300_000;
export const PROVIDER_ATTEMPT_PRESTART_LEASE_MS = 30_000;
const NONBLANK = /\S/;

function policyFingerprint(policy: ProviderAttemptAdmissionPolicy | null): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        protocol: 'provider-attempt-admission:v3',
        prestartLeaseMs: PROVIDER_ATTEMPT_PRESTART_LEASE_MS,
        observeWouldDenyLeaseMs: OBSERVE_WOULD_DENY_LEASE_MS,
        hardDeadline: true,
        immediateDecision: true,
        policy,
      }),
    )
    .digest('hex');
}

function fingerprint(
  identity: ProviderRequestIdentityT,
  providerStartFence: 'operation_kind' | undefined,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        attemptId: identity.attemptId,
        operationId: identity.operationId,
        attemptKind: identity.attemptKind,
        provider: identity.provider,
        model: identity.model,
        lane: identity.lane,
        protocol: identity.protocol,
        endpointClass: identity.endpointClass,
        caller: identity.caller,
        operationKind: identity.operationKind,
        ...(providerStartFence === undefined ? {} : { providerStartFence }),
      }),
    )
    .digest('hex');
}

function lifecycleError(
  reason: ProviderAttemptLifecycleReason,
  identity: ProviderRequestIdentityT,
) {
  return new ProviderAttemptLifecycleError(reason, identity.attemptId);
}

function requireIdentity(
  row: AttemptState,
  identity: ProviderRequestIdentityT,
  hash: string,
): void {
  if (row.identity_fingerprint !== null && row.identity_fingerprint !== hash) {
    throw lifecycleError('identity_collision', identity);
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
    throw lifecycleError('identity_collision', identity);
  }
}

function sameTerminal(
  row: AttemptState,
  evidence: ReturnType<typeof ProviderAttemptTerminalEvidence.parse>,
) {
  const usage = ProviderAttemptUsageTruth.safeParse(row.usage_json);
  return (
    usage.success &&
    row.terminal_status === evidence.terminal &&
    row.terminal_reason === evidence.reason &&
    row.wire_count === evidence.wireCount &&
    usage.data.basis === evidence.usage.basis &&
    usage.data.unit === evidence.usage.unit &&
    usage.data.input === evidence.usage.input &&
    usage.data.output === evidence.usage.output &&
    usage.data.total === evidence.usage.total &&
    usage.data.source === evidence.usage.source &&
    row.cost_basis === evidence.cost.basis &&
    row.cost_amount === evidence.cost.amount &&
    row.cost_currency === evidence.cost.currency &&
    row.cost_source === evidence.cost.source
  );
}

function controlFailure(
  mode: ProviderAttemptLifecycleMode,
  identity: ProviderRequestIdentityT,
  cause: unknown,
) {
  if (mode !== 'enforce') return undefined;
  throw new ProviderAttemptLifecycleError('control_plane_unavailable', identity.attemptId, cause);
}

export function createProviderAttemptLifecycle(input: {
  readonly mode: ProviderAttemptLifecycleMode;
  readonly persistAttemptWhenOff?: boolean;
  readonly policy?: ProviderAttemptAdmissionPolicy | null;
  readonly identity: ProviderRequestIdentityT;
  readonly deadlineAt: Date;
  readonly providerStartFence?: 'operation_kind';
  readonly db: Db;
}): ProviderAttemptLifecycle {
  const identity = ProviderRequestIdentity.parse(input.identity);
  if (!Number.isFinite(input.deadlineAt.getTime()))
    throw new RangeError('deadlineAt must be valid');
  const deadlineAtIso = input.deadlineAt.toISOString();
  const identityFingerprint = fingerprint(identity, input.providerStartFence);
  const policy = input.mode === 'off' ? null : (input.policy ?? null);
  const persistedMode = input.mode;
  const admissionPolicyFingerprint = policyFingerprint(policy);
  const leaseOwner = randomUUID();
  let acquired: Promise<ProviderAttemptHandle> | undefined;

  const makeHandle = (admission: ProviderAttemptAdmission): ProviderAttemptHandle => {
    const bypass = admission === 'off' || admission === 'untracked';
    let reserved: Promise<void> | undefined;
    return Object.freeze({
      admission,
      reserveProviderStart() {
        if (reserved) return reserved;
        reserved = (async () => {
          if (bypass) return;
          try {
            const blockerDecision = await input.db.transaction(
              async (tx): Promise<'active_duplicate' | 'recovery_required' | null> => {
                if (input.providerStartFence === 'operation_kind') {
                  await tx.execute(
                    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-attempt-operation-kind:${identity.operationId}:${identity.provider}:${identity.lane}:${identity.operationKind}`}, 0))`,
                  );
                  const candidateRows = await tx.execute<{ attempt_id: string }>(sql`
                    SELECT a.attempt_id::text
                    FROM provider_attempt AS a
                    JOIN provider_attempt_admission AS d USING (attempt_id)
                    WHERE a.attempt_id = ${identity.attemptId}
                      OR (
                        a.operation_id = ${identity.operationId}
                        AND a.provider = ${identity.provider}
                        AND a.lane_id = ${identity.lane}
                        AND a.operation_kind = ${identity.operationKind}
                        AND a.provider_start_reserved_at IS NOT NULL
                        AND d.status IN ('acquired', 'would_deny')
                      )
                  `);
                  const candidateIds = [
                    ...new Set([
                      identity.attemptId,
                      ...candidateRows.map((candidate) => candidate.attempt_id),
                    ]),
                  ].sort();
                  for (const candidateId of candidateIds) {
                    await tx.execute(
                      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-attempt:${candidateId}`}, 0))`,
                    );
                  }
                } else {
                  await tx.execute(
                    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-attempt:${identity.attemptId}`}, 0))`,
                  );
                }
                const rows = await tx.execute<{
                  provider_start_reserved_at: Date | string | null;
                  owned: boolean;
                  temporally_live: boolean;
                }>(sql`
                SELECT a.provider_start_reserved_at,
                  d.lease_owner = ${leaseOwner}::uuid
                    AND d.status IN ('acquired','would_deny') AS owned,
                  d.lease_expires_at > clock_timestamp()
                    AND d.deadline_at > clock_timestamp() AS temporally_live
                FROM provider_attempt a JOIN provider_attempt_admission d USING (attempt_id)
                WHERE a.attempt_id = ${identity.attemptId}
              `);
                const row = rows[0];
                if (!row?.owned) throw lifecycleError('lease_lost', identity);
                if (row.provider_start_reserved_at !== null) return null;
                if (input.mode === 'enforce' && !row.temporally_live) {
                  throw lifecycleError('lease_lost', identity);
                }
                if (input.providerStartFence === 'operation_kind') {
                  const fencedAtRows = await tx.execute<{ fenced_at: string }>(
                    sql`SELECT clock_timestamp()::text AS fenced_at`,
                  );
                  const fencedAt = fencedAtRows[0]?.fenced_at;
                  if (fencedAt === undefined) throw lifecycleError('lease_lost', identity);
                  await tx.execute(sql`
                  UPDATE provider_attempt_admission AS d
                  SET status = CASE
                      WHEN d.lease_expires_at <= ${fencedAt}::timestamptz
                        THEN 'lease_expired'
                      ELSE 'released'
                    END,
                    terminal_at = ${fencedAt}::timestamptz,
                    terminal_reason = CASE
                      WHEN d.lease_expires_at <= ${fencedAt}::timestamptz
                        THEN 'lease_expired'
                      ELSE 'deadline_elapsed'
                    END
                  FROM provider_attempt AS a
                  WHERE d.attempt_id = a.attempt_id
                    AND a.attempt_id <> ${identity.attemptId}
                    AND a.operation_id = ${identity.operationId}
                    AND a.provider = ${identity.provider}
                    AND a.lane_id = ${identity.lane}
                    AND a.operation_kind = ${identity.operationKind}
                    AND a.provider_start_reserved_at IS NOT NULL
                    AND d.status IN ('acquired', 'would_deny')
                    AND (d.lease_expires_at <= ${fencedAt}::timestamptz
                      OR d.deadline_at <= ${fencedAt}::timestamptz)
                `);
                  const blockers = await tx.execute<{ live: boolean }>(sql`
                  SELECT d.status IN ('acquired', 'would_deny')
                    AND d.lease_expires_at > ${fencedAt}::timestamptz
                    AND d.deadline_at > ${fencedAt}::timestamptz AS live
                  FROM provider_attempt a
                  LEFT JOIN provider_attempt_admission d USING (attempt_id)
                  WHERE a.attempt_id <> ${identity.attemptId}
                    AND a.operation_id = ${identity.operationId}
                    AND a.provider = ${identity.provider}
                    AND a.lane_id = ${identity.lane}
                    AND a.operation_kind = ${identity.operationKind}
                    AND a.provider_start_reserved_at IS NOT NULL
                  ORDER BY a.started_at DESC, a.attempt_id DESC
                `);
                  const decision = blockers.some((blocker) => blocker.live)
                    ? 'active_duplicate'
                    : blockers.length > 0
                      ? 'recovery_required'
                      : null;
                  if (decision !== null) {
                    const released = await tx
                      .update(provider_attempt_admission)
                      .set({
                        status: 'released',
                        terminal_at: sql`clock_timestamp()`,
                        terminal_reason: `provider_start_${decision}`,
                      })
                      .where(sql`${provider_attempt_admission.attempt_id} = ${identity.attemptId}
                      AND ${provider_attempt_admission.lease_owner} = ${leaseOwner}
                      AND ${provider_attempt_admission.status} IN ('acquired','would_deny')`)
                      .returning({ attempt_id: provider_attempt_admission.attempt_id });
                    if (released.length !== 1) throw lifecycleError('lease_lost', identity);
                    return decision;
                  }
                }
                const updated = await tx
                  .update(provider_attempt)
                  .set({ provider_start_reserved_at: sql`clock_timestamp()` })
                  .where(sql`${provider_attempt.attempt_id} = ${identity.attemptId}
                  AND ${provider_attempt.provider_start_reserved_at} IS NULL
                  AND EXISTS (SELECT 1 FROM provider_attempt_admission d
                    WHERE d.attempt_id = ${provider_attempt.attempt_id}
                      AND d.lease_owner = ${leaseOwner}
                      AND d.status IN ('acquired','would_deny'))`)
                  .returning({ attempt_id: provider_attempt.attempt_id });
                if (updated.length !== 1) throw lifecycleError('lease_lost', identity);
                await tx
                  .update(provider_attempt_admission)
                  .set({ lease_expires_at: sql`${provider_attempt_admission.deadline_at}` })
                  .where(sql`${provider_attempt_admission.attempt_id} = ${identity.attemptId}
                  AND ${provider_attempt_admission.lease_owner} = ${leaseOwner}
                  AND ${provider_attempt_admission.status} IN ('acquired','would_deny')`);
                return null;
              },
            );
            if (blockerDecision !== null) throw lifecycleError(blockerDecision, identity);
          } catch (error) {
            if (error instanceof ProviderAttemptLifecycleError) throw error;
            controlFailure(input.mode, identity, error);
          }
        })();
        return reserved;
      },
      async recordExternalRequestId(id: string) {
        if (!NONBLANK.test(id)) throw new TypeError('external request id must be nonblank');
        if (bypass) return;
        try {
          await input.db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-attempt:${identity.attemptId}`}, 0))`,
            );
            const rows = await tx.execute<{
              external_request_id: string | null;
              owned: boolean;
            }>(sql`
              SELECT a.external_request_id,
                     EXISTS (SELECT 1 FROM provider_attempt_admission d
                       WHERE d.attempt_id = a.attempt_id AND d.lease_owner = ${leaseOwner}
                         AND d.status IN ('acquired','would_deny')) AS owned
              FROM provider_attempt a WHERE a.attempt_id = ${identity.attemptId}
            `);
            const row = rows[0];
            if (!row?.owned) throw lifecycleError('lease_lost', identity);
            if (row.external_request_id !== null && row.external_request_id !== id) {
              throw lifecycleError('external_request_id_conflict', identity);
            }
            await tx
              .update(provider_attempt)
              .set({ external_request_id: id })
              .where(
                sql`${provider_attempt.attempt_id} = ${identity.attemptId}
                  AND ${provider_attempt.external_request_id} IS NULL`,
              );
          });
        } catch (error) {
          if (error instanceof ProviderAttemptLifecycleError) throw error;
          controlFailure(input.mode, identity, error);
        }
      },
      async finish(rawEvidence: ProviderAttemptTerminalEvidenceT) {
        if (bypass) return 'untracked' as const;
        const evidence = ProviderAttemptTerminalEvidence.parse(rawEvidence);
        if (identity.attemptKind === 'opaque_operation' && evidence.wireCount !== null) {
          throw lifecycleError('opaque_wire_count', identity);
        }
        try {
          return await input.db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-attempt:${identity.attemptId}`}, 0))`,
            );
            const rows = await tx.execute<AttemptState>(sql`SELECT a.terminal_status,
              a.terminal_reason, a.wire_count, a.usage_json, a.cost_basis, a.cost_amount,
              a.cost_currency, a.cost_source,
              a.provider_start_reserved_at,
              NULL::uuid::text AS operation_id, NULL::text AS attempt_kind, NULL::text AS provider,
              NULL::text AS model, NULL::text AS lane_id, NULL::text AS protocol,
              NULL::text AS endpoint_class, NULL::text AS caller, NULL::text AS operation_kind,
              a.external_request_id, NULL::text AS identity_fingerprint,
              d.status AS admission_status, d.lease_owner::text,
              NULL::boolean AS lease_live, NULL::boolean AS deadline_matches
              FROM provider_attempt a LEFT JOIN provider_attempt_admission d USING (attempt_id)
              WHERE a.attempt_id = ${identity.attemptId}`);
            const row = rows[0];
            if (!row) throw lifecycleError('lease_lost', identity);
            if (row.terminal_status !== null) {
              if (row.lease_owner !== leaseOwner) throw lifecycleError('lease_lost', identity);
              if (sameTerminal(row, evidence)) return 'already_settled' as const;
              throw lifecycleError('terminal_conflict', identity);
            }
            const settled = await tx
              .update(provider_attempt)
              .set({
                terminal_status: evidence.terminal,
                terminal_reason: evidence.reason,
                wire_count: evidence.wireCount,
                usage_json: evidence.usage,
                cost_basis: evidence.cost.basis,
                cost_amount: evidence.cost.amount,
                cost_currency: evidence.cost.currency,
                cost_source: evidence.cost.source,
                finished_at: sql`clock_timestamp()`,
              })
              .where(sql`${provider_attempt.attempt_id} = ${identity.attemptId}
                AND ${provider_attempt.finished_at} IS NULL
                AND EXISTS (SELECT 1 FROM provider_attempt_admission d
                  WHERE d.attempt_id = ${provider_attempt.attempt_id}
                    AND d.lease_owner = ${leaseOwner}
                    AND d.status IN ('acquired','would_deny'))`)
              .returning({ attempt_id: provider_attempt.attempt_id });
            if (settled.length !== 1) throw lifecycleError('lease_lost', identity);
            await tx
              .update(provider_attempt_admission)
              .set({
                status: 'released',
                terminal_at: sql`clock_timestamp()`,
                terminal_reason: 'attempt_finished',
              })
              .where(sql`${provider_attempt_admission.attempt_id} = ${identity.attemptId}
                AND ${provider_attempt_admission.lease_owner} = ${leaseOwner}
                AND ${provider_attempt_admission.status} IN ('acquired','would_deny')`);
            return 'settled' as const;
          });
        } catch (error) {
          if (error instanceof ProviderAttemptLifecycleError) throw error;
          return controlFailure(input.mode, identity, error) ?? 'untracked';
        }
      },
    });
  };

  return Object.freeze({
    identity,
    acquire() {
      if (acquired) return acquired;
      acquired = (async () => {
        if (input.mode === 'off' && input.persistAttemptWhenOff !== true) return makeHandle('off');
        try {
          const admission = await input.db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-attempt:${identity.attemptId}`}, 0))`,
            );
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-attempt-lane:${identity.lane}`}, 0))`,
            );
            const rows =
              await tx.execute<AttemptState>(sql`SELECT a.operation_id::text, a.attempt_kind,
              a.provider, a.model, a.lane_id, a.protocol, a.endpoint_class, a.caller,
              a.operation_kind, a.external_request_id, a.terminal_status, a.terminal_reason,
              a.wire_count, a.usage_json, a.cost_basis, a.cost_amount, a.cost_currency, a.cost_source,
              a.provider_start_reserved_at,
              d.identity_fingerprint, d.status AS admission_status, d.lease_owner::text,
              d.lease_expires_at > clock_timestamp() AS lease_live,
              d.deadline_at = ${deadlineAtIso}::timestamptz AS deadline_matches
              FROM provider_attempt_admission d FULL JOIN provider_attempt a USING (attempt_id)
              WHERE COALESCE(a.attempt_id, d.attempt_id) = ${identity.attemptId}`);
            const row = rows[0];
            const deadlineElapsed =
              (
                await tx.execute<{ elapsed: boolean }>(sql`
                  SELECT ${deadlineAtIso}::timestamptz <= clock_timestamp() AS elapsed
                `)
              )[0]?.elapsed === true;
            if (row) {
              requireIdentity(row, identity, identityFingerprint);
              if (
                row.terminal_status !== null ||
                row.admission_status === 'denied' ||
                row.admission_status === 'released' ||
                row.admission_status === 'lease_expired'
              ) {
                throw lifecycleError('terminal_reuse', identity);
              }
              if (row.admission_status !== null && row.deadline_matches !== true) {
                throw lifecycleError('deadline_mismatch', identity);
              }
              if (row.operation_id !== null && row.admission_status === null) {
                throw lifecycleError('recovery_required', identity);
              }
              if (
                identity.externalRequestId !== undefined &&
                row.external_request_id !== null &&
                row.external_request_id !== identity.externalRequestId
              ) {
                throw lifecycleError('external_request_id_conflict', identity);
              }
              if (row.lease_live === true && !(deadlineElapsed && input.mode === 'enforce')) {
                throw lifecycleError('active_duplicate', identity);
              }
              if (row.provider_start_reserved_at !== null) {
                throw lifecycleError('recovery_required', identity);
              }
            }
            if (deadlineElapsed && input.mode === 'enforce') {
              if (row?.operation_id !== null && row?.operation_id !== undefined) {
                await tx
                  .update(provider_attempt_admission)
                  .set({
                    mode: 'enforce',
                    status: 'denied',
                    lease_owner: null,
                    acquired_at: null,
                    lease_expires_at: null,
                    terminal_at: sql`clock_timestamp()`,
                    terminal_reason: 'deadline_elapsed',
                  })
                  .where(sql`${provider_attempt_admission.attempt_id} = ${identity.attemptId}`);
                return 'denied' as const;
              }
              await tx
                .insert(provider_attempt_admission)
                .values({
                  attempt_id: identity.attemptId,
                  identity_fingerprint: identityFingerprint,
                  policy_fingerprint: admissionPolicyFingerprint,
                  lane_id: identity.lane,
                  mode: 'enforce',
                  status: 'denied',
                  requested_at: sql`clock_timestamp()`,
                  deadline_at: input.deadlineAt,
                  terminal_at: sql`clock_timestamp()`,
                  terminal_reason: 'deadline_elapsed',
                })
                .onConflictDoNothing({ target: provider_attempt_admission.attempt_id });
              return 'denied' as const;
            }
            let policyViolation:
              | 'capacity_exhausted'
              | 'policy_mismatch'
              | 'rate_exhausted'
              | null = null;
            if (policy !== null) {
              const policyRows = await tx.execute<{
                active_count: number;
                starts_last_minute: number;
                mixed_policy: boolean;
              }>(sql`
                SELECT
                  COUNT(*) FILTER (WHERE status IN ('acquired','would_deny')
                    AND lease_expires_at > clock_timestamp())::int AS active_count,
                  COUNT(*) FILTER (WHERE acquired_at >= clock_timestamp() - interval '1 minute')::int
                    AS starts_last_minute,
                  BOOL_OR(policy_fingerprint <> ${admissionPolicyFingerprint}) FILTER (
                    WHERE status IN ('acquired','would_deny')
                      AND lease_expires_at > clock_timestamp()) AS mixed_policy
                FROM provider_attempt_admission
                WHERE lane_id = ${identity.lane}
                  AND mode IN ('observe', 'enforce')
              `);
              const policyState = policyRows[0];
              if (policyState?.mixed_policy === true) {
                policyViolation = 'policy_mismatch';
              } else if ((policyState?.active_count ?? 0) >= policy.maxConcurrentAttempts) {
                policyViolation = 'capacity_exhausted';
              } else if (
                (policyState?.starts_last_minute ?? 0) >= policy.maxAttemptStartsPerMinute
              ) {
                policyViolation = 'rate_exhausted';
              }
            }
            if (policyViolation !== null && input.mode === 'enforce') {
              await tx
                .insert(provider_attempt_admission)
                .values({
                  attempt_id: identity.attemptId,
                  identity_fingerprint: identityFingerprint,
                  policy_fingerprint: admissionPolicyFingerprint,
                  lane_id: identity.lane,
                  mode: 'enforce',
                  status: 'denied',
                  requested_at: sql`clock_timestamp()`,
                  deadline_at: input.deadlineAt,
                  terminal_at: sql`clock_timestamp()`,
                  terminal_reason: policyViolation,
                })
                .onConflictDoUpdate({
                  target: provider_attempt_admission.attempt_id,
                  set: {
                    identity_fingerprint: identityFingerprint,
                    policy_fingerprint: admissionPolicyFingerprint,
                    lane_id: identity.lane,
                    mode: 'enforce',
                    status: 'denied',
                    lease_owner: null,
                    requested_at: sql`clock_timestamp()`,
                    deadline_at: input.deadlineAt,
                    acquired_at: null,
                    lease_expires_at: null,
                    terminal_at: sql`clock_timestamp()`,
                    terminal_reason: policyViolation,
                  },
                });
              return policyViolation;
            }
            await tx
              .insert(provider_attempt)
              .values({
                attempt_id: identity.attemptId,
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
                started_at: sql`clock_timestamp()`,
              })
              .onConflictDoNothing({ target: provider_attempt.attempt_id });
            const status =
              input.mode === 'observe' && (deadlineElapsed || policyViolation !== null)
                ? 'would_deny'
                : 'acquired';
            await tx
              .insert(provider_attempt_admission)
              .values({
                attempt_id: identity.attemptId,
                identity_fingerprint: identityFingerprint,
                policy_fingerprint: admissionPolicyFingerprint,
                lane_id: identity.lane,
                mode: persistedMode,
                status,
                lease_owner: leaseOwner,
                requested_at: sql`clock_timestamp()`,
                deadline_at: input.deadlineAt,
                acquired_at: sql`clock_timestamp()`,
                lease_expires_at:
                  status === 'would_deny'
                    ? sql`clock_timestamp() + ${OBSERVE_WOULD_DENY_LEASE_MS} * interval '1 millisecond'`
                    : input.mode === 'off'
                      ? sql`clock_timestamp() + ${PROVIDER_ATTEMPT_PRESTART_LEASE_MS} * interval '1 millisecond'`
                      : sql`LEAST(${deadlineAtIso}::timestamptz,
                          clock_timestamp() + ${PROVIDER_ATTEMPT_PRESTART_LEASE_MS} * interval '1 millisecond')`,
                terminal_at: null,
                terminal_reason: null,
              })
              .onConflictDoUpdate({
                target: provider_attempt_admission.attempt_id,
                set: {
                  identity_fingerprint: identityFingerprint,
                  policy_fingerprint: admissionPolicyFingerprint,
                  lane_id: identity.lane,
                  mode: persistedMode,
                  status,
                  lease_owner: leaseOwner,
                  requested_at: sql`clock_timestamp()`,
                  acquired_at: sql`clock_timestamp()`,
                  lease_expires_at:
                    status === 'would_deny'
                      ? sql`clock_timestamp() + ${OBSERVE_WOULD_DENY_LEASE_MS} * interval '1 millisecond'`
                      : input.mode === 'off'
                        ? sql`clock_timestamp() + ${PROVIDER_ATTEMPT_PRESTART_LEASE_MS} * interval '1 millisecond'`
                        : sql`LEAST(${deadlineAtIso}::timestamptz,
                            clock_timestamp() + ${PROVIDER_ATTEMPT_PRESTART_LEASE_MS} * interval '1 millisecond')`,
                  terminal_at: null,
                  terminal_reason: null,
                },
              });
            if (identity.externalRequestId !== undefined) {
              await tx
                .update(provider_attempt)
                .set({ external_request_id: identity.externalRequestId })
                .where(sql`${provider_attempt.attempt_id} = ${identity.attemptId}
                  AND ${provider_attempt.external_request_id} IS NULL`);
            }
            return status as 'acquired' | 'would_deny';
          });
          if (admission === 'denied') throw lifecycleError('deadline_elapsed', identity);
          if (
            admission === 'capacity_exhausted' ||
            admission === 'policy_mismatch' ||
            admission === 'rate_exhausted'
          ) {
            throw lifecycleError(admission, identity);
          }
          return makeHandle(admission);
        } catch (error) {
          if (error instanceof ProviderAttemptLifecycleError) throw error;
          controlFailure(input.mode, identity, error);
          return makeHandle('untracked');
        }
      })();
      return acquired;
    },
  });
}
