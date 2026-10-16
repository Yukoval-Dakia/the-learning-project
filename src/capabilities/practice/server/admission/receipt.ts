import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  computePaidEffectIdentity,
  paidEffectJsonEquals,
} from '@/core/migration/paid-effect-protocol';
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
  const scope = and(
    eq(paid_effect.family, ADMISSION_FAMILY),
    eq(paid_effect.entity_id, prepared.group_id),
    eq(paid_effect.unit, 'admission@1'),
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
        eq(paid_effect.unit, 'admission@1'),
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
    unit: 'admission@1',
    input,
  };
  const identity = computePaidEffectIdentity(effect);
  const snapshot = existing ? await readPaidEffect(tx, identity) : null;
  if (existing && !snapshot) throw new Error('Frozen admission effect identity mismatch');
  if (snapshot?.state === 'applied') return { kind: 'applied' as const, input, identity };
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
  if (options.historicalTerminal) return { kind: 'historical' as const, input, identity };
  if (!options.maySend) return { kind: 'stale' as const, input, identity };
  await admitPaidEffectIntent(tx, effect);
  const claim = await claimPaidEffectSend(tx, identity, {
    backend: 'pg-boss',
    deliveryId: delivery.id,
    generation: delivery.jobData?.dispatch_generation ?? 0,
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
  if (claim.kind !== 'claimed') return { kind: 'held' as const, input, identity };
  return { kind: 'winner' as const, input, identity, fence: claim.fence };
}
