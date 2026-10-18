import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  computePaidEffectIdentity,
  paidEffectJsonEquals,
} from '@/core/migration/paid-effect-protocol';
import {
  type AdmissionReopenMarker,
  LEGACY_QUESTION_ADMISSION_PAID_UNIT,
  PREVIOUS_QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNITS,
} from '@/core/question-admission-policy';
import { ExecutionPlan } from '@/core/schema/assessment/execution';
import { Presentation } from '@/core/schema/assessment/presentation';
import { ResponseSpec } from '@/core/schema/assessment/response';
import { ScoringBasis } from '@/core/schema/assessment/scoring';
import { QuestionGroupStructure } from '@/core/schema/assessment/structure';
import type { Tx } from '@/db/client';
import { admitPaidEffectDeliveryControl } from '@/db/paid-effect-control';
import { admitPaidEffectIntent, claimPaidEffectSend, readPaidEffect } from '@/db/paid-effect-store';
import { paid_effect } from '@/db/schema';
import { SubjectProfileSchema } from '@/subjects/profile';
import { ADMISSION_FAMILY, type AdmissionJobData } from './enqueue';

const Contract = z.object({
  structure: QuestionGroupStructure,
  response_spec: ResponseSpec,
  scoring_basis: ScoringBasis,
  execution_plan: ExecutionPlan,
  integrity_digest: z.string().min(1),
  presentation: Presentation.optional(),
});
export const FrozenAdmissionInput = z.object({
  version: z.literal(1),
  group_id: z.string().min(1),
  revision_id: z.string().nullable(),
  revision_digest: z.string().nullable(),
  admission_generation: z.number().int().nonnegative(),
  contract: Contract.extend({
    group_id: z.string().min(1),
    conversion_issues: z.array(
      z.object({
        code: z.enum(['missing_reference', 'unrepresentable_answer', 'unverified_figure_digest']),
        partId: z.string(),
        detail: z.string(),
      }),
    ),
    rule_statement_origins: z
      .record(z.string(), z.enum(['reference', 'rubric', 'placeholder']))
      .optional(),
  }),
  subject_profile: SubjectProfileSchema,
  policy_id: z.string().min(1),
  solver2: z.object({ provider: z.string().optional(), model: z.string().optional() }).nullable(),
});
export type FrozenAdmissionInput = z.infer<typeof FrozenAdmissionInput>;

/** Keep full calibration/evidence payloads; validate the fields consumed during publication. */
export const AdmissionResultReceipt = z.object({
  version: z.literal(1),
  recorded_at: z.string().datetime(),
  result: z
    .object({
      status: z.enum(['admitted', 'withheld', 'pending']),
      reason: z.string().optional(),
      resolved: Contract.optional(),
      per_unit: z.array(
        z
          .object({
            scoring_unit_id: z.string(),
            status: z.enum(['admitted', 'withheld', 'pending']),
            reason: z.string().optional(),
          })
          .passthrough(),
      ),
      verification: z.object({
        policy_id: z.string(),
        outcome: z.enum(['passed', 'suspended', 'failed']),
        evidence: z.record(z.string(), z.unknown()),
      }),
      evidence_refs: z.object({ task_run_ids: z.array(z.string()) }).passthrough(),
    })
    .passthrough(),
});
export type AdmissionResultReceipt = z.infer<typeof AdmissionResultReceipt>;

/** Terminal application disposition is not necessarily a verified question. */
export function completedAdmissionStatus(application: unknown) {
  const { status } = z
    .object({ status: z.enum(['admitted', 'withheld', 'stale', 'conflict']) })
    .parse(application);
  return status === 'stale' || status === 'conflict' ? status : ('already_verified' as const);
}

const KIND_MISMATCH_CONFLICT = /key kind (blank_text vs blank_numeric|blank_numeric vs blank_text)/;

/**
 * True when an applied admission verdict withheld at least one unit on the
 * blank kind-mismatch branch of keysAgree (blank_text vs blank_numeric). The
 * marker check is deliberately narrow: solve_conflict from ANY other branch
 * keeps the applied row terminal.
 */
export function isKindMismatchSolveConflict(application: unknown): boolean {
  const parsed = z
    .object({
      status: z.literal('withheld'),
      per_unit: z
        .array(
          z
            .object({
              status: z.string().optional(),
              reason: z.string().optional(),
              solve: z
                .object({ verdict: z.string().optional(), detail: z.string().optional() })
                .passthrough()
                .optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough()
    .safeParse(application);
  if (!parsed.success) return false;
  return (parsed.data.per_unit ?? []).some(
    (unit) =>
      unit.status === 'withheld' &&
      unit.reason === 'solve_conflict' &&
      unit.solve?.verdict === 'conflict' &&
      KIND_MISMATCH_CONFLICT.test(unit.solve.detail ?? ''),
  );
}

/**
 * The one marked YUK-1547 exception: the named same-base @2 row is an
 * unresolved unknown send, or an applied verdict withheld on the blank
 * kind-mismatch conflict. Anything else stays terminal.
 */
export function reopenMarkedRowEligibility(row: {
  state: string;
  application: unknown;
}): 'unknown' | 'applied_conflict' | null {
  if (row.state === 'unknown') return 'unknown';
  if (row.state === 'applied' && isKindMismatchSolveConflict(row.application)) {
    return 'applied_conflict';
  }
  return null;
}

/**
 * Whether an applied verdict stays terminal for a new claim: every applied row
 * blocks EXCEPT the single marker-named @2 row whose withhold was the blank
 * kind-mismatch conflict. Without the marker nothing is exempt.
 */
export function appliedVerdictBlocksClaim(
  applied: { unit: string; inputDigest: string; application: unknown },
  marker: AdmissionReopenMarker | undefined,
): boolean {
  return !(
    marker != null &&
    applied.unit === marker.unit &&
    applied.inputDigest === marker.inputDigest &&
    isKindMismatchSolveConflict(applied.application)
  );
}

export type AdmissionDelivery = { id: string; jobData?: AdmissionJobData };

export async function assertAdmissionDelivery(tx: Tx, delivery: AdmissionDelivery) {
  if (!delivery.jobData) return; // Explicit direct invocation, still claimed in paid_effect.
  const [job] = await tx.execute<{ name: string; state: string; data: unknown }>(sql`
    select name, state::text as state, data from pgboss.job
    where id = ${delivery.id}::uuid for update
  `);
  if (
    !job ||
    job.name !== ADMISSION_FAMILY ||
    job.state !== 'active' ||
    !paidEffectJsonEquals(job.data, delivery.jobData)
  ) {
    throw new Error('Question admission original pg-boss delivery is not active or differs');
  }
}

/**
 * Called under family-control + root/lifecycle locks. A claim covers the entire
 * bounded admission batch, not an individual queue attempt. A crash after any
 * send holds the whole batch; queue retry never restarts its paid calls.
 */
export async function claimAdmissionBatch(
  tx: Tx,
  prepared: FrozenAdmissionInput,
  delivery: AdmissionDelivery,
  options: { maySend: boolean; historicalTerminal: boolean },
) {
  const version = delivery.jobData?.admission_version;
  // Direct invocations (no jobData) run the current @3 contract; job deliveries
  // claim their own version's unit. A job carrying no admission_version is an
  // old queued @1 delivery — it may reconcile @1 but never initiate @3.
  const unit =
    delivery.jobData == null || version === 3
      ? QUESTION_ADMISSION_PAID_UNIT
      : version === 2
        ? PREVIOUS_QUESTION_ADMISSION_PAID_UNIT
        : LEGACY_QUESTION_ADMISSION_PAID_UNIT;
  // Lead-only YUK-1547 marker: names the exact same-base @2 row one marked @3
  // send re-opens. Verified BEFORE any terminal short-circuit — a marker that
  // names a missing or ineligible row fails the job, and it is never inferred.
  const markedIdentity = version === 3 ? delivery.jobData?.reopen_paid_effect_identity : undefined;
  const marker: AdmissionReopenMarker | undefined = markedIdentity
    ? { unit: markedIdentity.unit, inputDigest: markedIdentity.input_digest }
    : undefined;
  let markedEligibility: 'unknown' | 'applied_conflict' | null = null;
  if (marker) {
    const [markedRow] = await tx
      .select()
      .from(paid_effect)
      .where(
        and(
          eq(paid_effect.family, ADMISSION_FAMILY),
          eq(paid_effect.entity_id, prepared.group_id),
          eq(paid_effect.entity_revision, prepared.contract.integrity_digest),
          eq(paid_effect.unit, marker.unit),
          eq(paid_effect.input_digest, marker.inputDigest),
        ),
      )
      .for('update')
      .limit(1);
    markedEligibility = markedRow
      ? reopenMarkedRowEligibility({
          state: markedRow.state,
          application: markedRow.application_json,
        })
      : null;
    // An applied-but-ordinary verdict falls through to the applied scan below,
    // which returns the terminal 'applied' — the marker cannot override it.
    if (markedEligibility == null && markedRow?.state !== 'applied') {
      throw new Error(
        `Question admission reopen marker does not name an eligible same-base ${marker.unit} row`,
      );
    }
  }
  // An applied verdict from ANY contract version is terminal for this base —
  // except the single lead-marked @2 kind-mismatch solve_conflict reopen, which
  // is the ONLY applied row this loop may pass over.
  const appliedRows = await tx
    .select()
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, ADMISSION_FAMILY),
        eq(paid_effect.entity_id, prepared.group_id),
        eq(paid_effect.entity_revision, prepared.contract.integrity_digest),
        inArray(paid_effect.unit, [...QUESTION_ADMISSION_PAID_UNITS]),
        eq(paid_effect.state, 'applied'),
      ),
    )
    .for('update');
  for (const applied of appliedRows) {
    if (
      !appliedVerdictBlocksClaim(
        {
          unit: applied.unit,
          inputDigest: applied.input_digest,
          application: applied.application_json,
        },
        marker,
      )
    ) {
      continue;
    }
    const input = FrozenAdmissionInput.parse(applied.input_json);
    return {
      kind: 'applied' as const,
      input,
      identity: computePaidEffectIdentity({
        family: ADMISSION_FAMILY,
        entityId: input.group_id,
        entityRevision: input.contract.integrity_digest,
        unit: applied.unit,
        input,
      }),
      status: completedAdmissionStatus(applied.application_json),
    };
  }
  const scope = and(
    eq(paid_effect.family, ADMISSION_FAMILY),
    eq(paid_effect.entity_id, prepared.group_id),
    eq(paid_effect.unit, unit),
  );
  const revisionId = delivery.jobData?.revision_id ?? prepared.revision_id;
  // Prefer the original delivery/revision even if mutable rows changed after payment.
  const [pinned] = await tx
    .select()
    .from(paid_effect)
    .where(
      and(
        scope,
        or(
          eq(paid_effect.delivery_id, delivery.id),
          ...(revisionId ? [sql`${paid_effect.input_json}->>'revision_id' = ${revisionId}`] : []),
        ),
      ),
    )
    .for('update')
    .limit(1);
  const [byDigest] = await tx
    .select()
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, ADMISSION_FAMILY),
        eq(paid_effect.entity_id, prepared.group_id),
        eq(paid_effect.entity_revision, prepared.contract.integrity_digest),
        eq(paid_effect.unit, unit),
      ),
    )
    .for('update')
    .limit(1);
  // Reuse the FIRST frozen inputs, including profile and policy. Configuration
  // drift cannot turn a retry into a different paid identity for this digest.
  const existing = pinned ?? byDigest;
  const input = existing ? FrozenAdmissionInput.parse(existing.input_json) : prepared;
  const effect = {
    family: ADMISSION_FAMILY,
    entityId: input.group_id,
    entityRevision: input.contract.integrity_digest,
    unit,
    input,
  };
  const identity = computePaidEffectIdentity(effect);
  const snapshot = existing ? await readPaidEffect(tx, identity) : null;
  if (existing && !snapshot) throw new Error('Frozen admission effect identity mismatch');
  if (snapshot?.state === 'applied')
    return {
      kind: 'applied' as const,
      input,
      identity,
      status: completedAdmissionStatus(snapshot.application),
    };
  const admission = await admitPaidEffectDeliveryControl(tx, ADMISSION_FAMILY, {
    backend: 'pg-boss',
    deliveryId: delivery.id,
    generation: delivery.jobData?.dispatch_generation ?? 0,
  });
  if (admission.kind === 'fenced')
    throw new Error('Question admission delivery backend/generation fenced');
  if (snapshot?.state === 'receipt_ready') {
    return {
      kind: 'receipt' as const,
      input,
      identity,
      receipt: AdmissionResultReceipt.parse(snapshot.result),
    };
  }
  if (snapshot?.state === 'sending' || snapshot?.state === 'unknown')
    return { kind: 'held' as const, input, identity };
  // A terminal verification suppresses re-payment — except the marked @2 row
  // this exact send is authorized to re-open. Normal jobs still see 'historical'.
  if (options.historicalTerminal && markedEligibility == null)
    return { kind: 'historical' as const, input, identity };
  // Old-version deliveries keep reconciling their own unit's rows above but can
  // never initiate a paid send under the @3 contract.
  if (unit !== QUESTION_ADMISSION_PAID_UNIT || !options.maySend)
    return { kind: 'stale' as const, input, identity };
  await admitPaidEffectIntent(tx, effect);
  const claim = await claimPaidEffectSend(tx, identity, {
    backend: 'pg-boss',
    deliveryId: delivery.id,
    generation: delivery.jobData?.dispatch_generation ?? 0,
    admissionReopenMarker: marker,
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  if (claim.kind !== 'claimed') return { kind: 'held' as const, input, identity };
  return { kind: 'winner' as const, input, identity, fence: claim.fence };
}
