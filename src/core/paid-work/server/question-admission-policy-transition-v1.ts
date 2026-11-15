import { and, eq, inArray, ne, or } from 'drizzle-orm';
import {
  PAID_EFFECT_AUTHORIZATION_OPEN_STATES,
  PAID_EFFECT_ENTITY_GATE_STATES,
  type PaidEffectIdentity,
  type PaidEffectInput,
  type PaidEffectVoidReceipt,
  computePaidEffectIdentity,
  paidEffectJsonEquals,
} from '@/core/paid-work/protocol/paid-effect-protocol';
import { lockPaidEffectControlFamily } from '@/core/paid-work/server/paid-effect-control';
import {
  type PaidEffectSendClaimDelivery,
  admitPaidEffectIntent,
} from '@/core/paid-work/server/paid-effect-store';
import {
  readQuestionAdmissionPolicySuccessorV1,
  recordQuestionAdmissionPolicySuccessorV1,
} from '@/core/paid-work/server/question-admission-policy-successor-v1';
import type { Tx } from '@/db/client';
import { paid_effect, paid_effect_authorization } from '@/db/schema';
import { lockPaidEffectEntityGate } from '@/kernel/locks/paid-effect-gate';

const FAMILY = 'question_admission_run';
const OPEN_SUCCESSOR_STATES: readonly string[] = PAID_EFFECT_AUTHORIZATION_OPEN_STATES;

async function lockAdmissionEffect(tx: Tx, identity: PaidEffectIdentity) {
  await lockPaidEffectControlFamily(tx, identity.family);
  const [row] = await tx
    .select()
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, identity.family),
        eq(paid_effect.entity_id, identity.entityId),
        eq(paid_effect.entity_revision, identity.entityRevision),
        eq(paid_effect.unit, identity.unit),
        eq(paid_effect.input_digest, identity.inputDigest),
      ),
    )
    .for('update');
  return row ?? null;
}

async function hasUnresolvedAdmissionEffect(tx: Tx, identity: PaidEffectIdentity) {
  const [row] = await tx
    .select({ unit: paid_effect.unit })
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, FAMILY),
        eq(paid_effect.entity_id, identity.entityId),
        inArray(paid_effect.state, [...PAID_EFFECT_ENTITY_GATE_STATES]),
        or(
          ne(paid_effect.entity_revision, identity.entityRevision),
          ne(paid_effect.unit, identity.unit),
          ne(paid_effect.input_digest, identity.inputDigest),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

function sameIdentity(a: PaidEffectIdentity, b: PaidEffectIdentity): boolean {
  return (
    a.family === b.family &&
    a.entityId === b.entityId &&
    a.entityRevision === b.entityRevision &&
    a.unit === b.unit &&
    a.inputDigest === b.inputDigest
  );
}

/**
 * Versioned exception to the original exact-successor protocol, only for admission
 * @4 -> @5. Mapping and intent admission share the send claim's transaction and locks.
 * The old pending row and authorization remain immutable, truthful never-sent evidence.
 */
export async function transitionQuestionAdmissionV4V5SuccessorV1(
  tx: Tx,
  next: PaidEffectInput,
  delivery: PaidEffectSendClaimDelivery,
  preparedInput: unknown,
): Promise<'mapped' | 'held' | 'not_applicable'> {
  if (next.family !== FAMILY || next.unit !== 'admission@5') return 'not_applicable';
  const identity = computePaidEffectIdentity(next);
  await lockPaidEffectControlFamily(tx, identity.family);
  const auths = await tx
    .select()
    .from(paid_effect_authorization)
    .where(
      and(
        eq(paid_effect_authorization.family, identity.family),
        eq(paid_effect_authorization.entity_id, identity.entityId),
        eq(paid_effect_authorization.successor_entity_revision, identity.entityRevision),
        eq(paid_effect_authorization.successor_unit, 'admission@4'),
      ),
    );
  if (auths.length > 0) {
    await lockPaidEffectControlFamily(tx, 'question_admission_stage');
    const [unresolvedStage] = await tx
      .select({ unit: paid_effect.unit })
      .from(paid_effect)
      .where(
        and(
          eq(paid_effect.family, 'question_admission_stage'),
          eq(paid_effect.entity_id, identity.entityId),
          inArray(paid_effect.state, ['sending', 'unknown']),
        ),
      )
      .limit(1);
    if (unresolvedStage) return 'held';
  }
  for (const auth of auths) {
    if (!paidEffectJsonEquals(next.input, preparedInput)) return 'held';
    const original: PaidEffectIdentity = {
      family: auth.family,
      entityId: auth.entity_id,
      entityRevision: auth.successor_entity_revision,
      unit: auth.successor_unit,
      inputDigest: auth.successor_input_digest,
    };
    const target = await lockAdmissionEffect(tx, identity);
    const row = await lockAdmissionEffect(tx, original);
    const predecessor = await lockAdmissionEffect(tx, {
      family: auth.family,
      entityId: auth.entity_id,
      entityRevision: auth.entity_revision,
      unit: auth.unit,
      inputDigest: auth.input_digest,
    });
    await lockPaidEffectEntityGate(tx, identity);
    const mapping = await readQuestionAdmissionPolicySuccessorV1(tx, auth);
    if (mapping) {
      if (
        delivery.backend !== 'pg-boss' ||
        !sameIdentity(mapping.successor, identity) ||
        mapping.successor_delivery_id !== delivery.deliveryId ||
        !target ||
        target.state !== 'pending' ||
        target.fence !== 0 ||
        !paidEffectJsonEquals(target.input_json, next.input)
      )
        return 'held';
      return 'mapped';
    }
    if (!row || !OPEN_SUCCESSOR_STATES.includes(row.state)) continue;
    const receipt = predecessor?.void_json as PaidEffectVoidReceipt | null;
    if (
      delivery.backend !== 'pg-boss' ||
      row.state !== 'pending' ||
      row.fence !== 0 ||
      row.delivery_backend !== null ||
      row.delivery_id !== null ||
      row.delivery_tick !== null ||
      row.send_lease_expires_at !== null ||
      row.result_json !== null ||
      row.result_recorded_at !== null ||
      row.application_json !== null ||
      row.applied_at !== null ||
      predecessor?.state !== 'voided' ||
      receipt?.authorizationId !== auth.authorization_id ||
      receipt?.reason !== auth.reason ||
      receipt?.operator !== auth.operator ||
      receipt?.basis !== auth.basis ||
      receipt?.previousFence !== predecessor.fence - 1 ||
      !paidEffectJsonEquals(receipt?.successor, original) ||
      receipt?.successorDelivery.backend !== auth.successor_delivery_backend ||
      receipt?.successorDelivery.deliveryId !== auth.successor_delivery_id
    )
      return 'held';
    // This family has no parallel feature-rep exception to its entity gate.
    if (await hasUnresolvedAdmissionEffect(tx, identity)) return 'held';
    const proven = await recordQuestionAdmissionPolicySuccessorV1(
      tx,
      auth,
      row.input_json,
      next,
      delivery.deliveryId,
    );
    if (!proven) return 'held';
    await admitPaidEffectIntent(tx, next);
    return 'mapped';
  }
  return 'not_applicable';
}
