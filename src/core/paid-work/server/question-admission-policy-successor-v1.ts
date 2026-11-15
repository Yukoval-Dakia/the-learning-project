import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  PaidEffectAuthorizationError,
  type PaidEffectIdentity,
  type PaidEffectInput,
  computePaidEffectIdentity,
  paidEffectIdentitySchema,
  paidEffectJsonEquals,
} from '@/core/paid-work/protocol/paid-effect-protocol';
import type { Tx } from '@/db/client';
import { event, type paid_effect_authorization } from '@/db/schema';

type Authorization = typeof paid_effect_authorization.$inferSelect;

const FAMILY = 'question_admission_run';
const ACTION = 'experimental:paid_question_admission_policy_successor_v1';
const ACTOR = 'paid-work:question_admission_policy_successor_v1';
const Mapping = z.strictObject({
  version: z.literal(1),
  authorization_id: z.string(),
  original: paidEffectIdentitySchema,
  original_delivery_id: z.string(),
  successor: paidEffectIdentitySchema,
  successor_delivery_id: z.string(),
  publication_id: z.string(),
  usage_source_event_id: z.string().nullable(),
});

const InputBinding = z.object({
  group_id: z.string().min(1),
  revision_id: z.string().min(1),
  revision_digest: z.string().min(1),
  admission_generation: z.number().int().nonnegative(),
  policy_id: z.literal('question_admission@5'),
  contract: z.object({ group_id: z.string(), integrity_digest: z.string() }),
});
const JobBinding = z.object({
  admission_version: z.number(),
  question_id: z.string(),
  revision_id: z.string(),
  expected_revision_digest: z.string(),
  expected_admission_generation: z.number(),
  dispatch_generation: z.number().int().nonnegative().optional(),
  source_event_id: z.string(),
  usage_source_event_id: z.string().optional(),
});
const PurposeBinding = z.strictObject({
  version: z.literal(1),
  job_id: z.string(),
  source_event_id: z.string(),
  usage_source_event_id: z.string().nullable(),
  question_id: z.string(),
  revision_id: z.string(),
  revision_digest: z.string(),
  derivation_policy: z.literal('answer_only'),
});

/** Canonical @5 delivery, shared with the admission producer; never an arbitrary UUID. */
export function questionAdmissionV5DeliveryId(
  groupId: string,
  revisionId: string,
  digest: string,
  generation: number,
  contractVersion: 5,
): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([FAMILY, contractVersion, groupId, revisionId, digest, generation]))
    .digest('hex');
  const value = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function originalIdentity(auth: Authorization): PaidEffectIdentity {
  return {
    family: auth.family,
    entityId: auth.entity_id,
    entityRevision: auth.successor_entity_revision,
    unit: auth.successor_unit,
    inputDigest: auth.successor_input_digest,
  };
}

const mappingId = (auth: Authorization) =>
  `paid-admission-v4-v5:${
    computePaidEffectIdentity({
      ...originalIdentity(auth),
      input: { authorization_id: auth.authorization_id, original: originalIdentity(auth) },
    }).inputDigest
  }`;

/** Called under the paid family's lock. Absence is legacy behavior; corruption fences. */
export async function readQuestionAdmissionPolicySuccessorV1(tx: Tx, auth: Authorization) {
  if (auth.family !== FAMILY || auth.successor_unit !== 'admission@4') return null;
  const [row] = await tx
    .select()
    .from(event)
    .where(eq(event.id, mappingId(auth)))
    .limit(1);
  if (!row) return null;
  const mapping = Mapping.parse(row.payload);
  if (
    row.action !== ACTION ||
    row.actor_kind !== 'system' ||
    row.actor_ref !== ACTOR ||
    row.subject_kind !== 'question' ||
    row.subject_id !== auth.entity_id ||
    row.outcome !== 'success' ||
    row.caused_by_event_id !== mapping.publication_id ||
    mapping.authorization_id !== auth.authorization_id ||
    !paidEffectJsonEquals(mapping.original, originalIdentity(auth)) ||
    mapping.original_delivery_id !== auth.successor_delivery_id ||
    auth.successor_delivery_backend !== 'pg-boss' ||
    mapping.successor.family !== FAMILY ||
    mapping.successor.entityId !== auth.entity_id ||
    mapping.successor.entityRevision !== auth.successor_entity_revision ||
    mapping.successor.unit !== 'admission@5'
  ) {
    throw new PaidEffectAuthorizationError('Invalid admission@4 -> @5 policy mapping');
  }
  return mapping;
}

/**
 * Exact policy/removed-solver translation only. The caller holds family/row/entity locks and
 * admits the mapped intent in this transaction; no original paid fact is changed.
 */
export async function recordQuestionAdmissionPolicySuccessorV1(
  tx: Tx,
  auth: Authorization,
  oldInput: unknown,
  next: PaidEffectInput,
  deliveryId: string,
): Promise<boolean> {
  const input = InputBinding.safeParse(next.input);
  const identity = computePaidEffectIdentity(next);
  if (
    !input.success ||
    next.family !== FAMILY ||
    next.unit !== 'admission@5' ||
    auth.family !== FAMILY ||
    auth.successor_unit !== 'admission@4' ||
    auth.successor_delivery_backend !== 'pg-boss' ||
    auth.consumed_at !== null ||
    auth.consumed_delivery_id !== null ||
    !z.uuid().safeParse(auth.successor_delivery_id).success ||
    Object.hasOwn(next.input as object, 'solver2')
  )
    return false;
  const frozen = input.data;
  if (
    next.entityId !== frozen.group_id ||
    auth.entity_id !== frozen.group_id ||
    frozen.contract.group_id !== frozen.group_id ||
    next.entityRevision !== frozen.revision_digest ||
    frozen.contract.integrity_digest !== frozen.revision_digest ||
    auth.successor_entity_revision !== next.entityRevision ||
    deliveryId !==
      questionAdmissionV5DeliveryId(
        frozen.group_id,
        frozen.revision_id,
        frozen.revision_digest,
        frozen.admission_generation,
        5,
      )
  )
    return false;
  const oldPolicy = z
    .object({
      policy_id: z.literal('question_admission@4'),
      solver2: z
        .strictObject({ provider: z.string().optional(), model: z.string().optional() })
        .nullable()
        .optional(),
    })
    .safeParse(oldInput);
  if (!oldPolicy.success) return false;
  const legacyInput = {
    ...(next.input as Record<string, unknown>),
    policy_id: 'question_admission@4',
    ...(Object.hasOwn(oldInput as object, 'solver2') ? { solver2: oldPolicy.data.solver2 } : {}),
  };
  if (
    !paidEffectJsonEquals(oldInput, legacyInput) ||
    computePaidEffectIdentity({ ...next, unit: 'admission@4', input: oldInput }).inputDigest !==
      auth.successor_input_digest
  )
    return false;

  // PgBoss may have completed the stale @4 wake. Its real original row must still
  // prove the bound envelope; a purged/unbound delivery cannot be reconstructed.
  const jobs = await tx.execute<{ id: string; name: string; state: string; data: unknown }>(sql`
    select id::text, name, state::text, data from pgboss.job
    where id in (${auth.successor_delivery_id}::uuid, ${deliveryId}::uuid)
    order by id for update
  `);
  const oldJob = jobs.find((job) => job.id === auth.successor_delivery_id);
  const newJob = jobs.find((job) => job.id === deliveryId);
  const oldData = JobBinding.safeParse(oldJob?.data);
  const newData = JobBinding.safeParse(newJob?.data);
  if (
    oldJob?.name !== FAMILY ||
    newJob?.name !== FAMILY ||
    newJob.state !== 'active' ||
    !oldData.success ||
    !newData.success ||
    oldData.data.admission_version !== 4 ||
    newData.data.admission_version !== 5 ||
    (oldData.data.dispatch_generation ?? 0) !== (newData.data.dispatch_generation ?? 0)
  )
    return false;
  const bindings = [];
  for (const [jobId, data] of [
    [auth.successor_delivery_id, oldData.data],
    [deliveryId, newData.data],
  ] as const) {
    const [row] = await tx
      .select()
      .from(event)
      .where(eq(event.id, `question-admission-purpose:${jobId}`))
      .limit(1);
    const parsed = PurposeBinding.safeParse(row?.payload);
    if (
      !parsed.success ||
      row?.action !== 'experimental:question_admission_purpose' ||
      row.actor_kind !== 'system' ||
      row.actor_ref !== 'practice:question_admission' ||
      row.subject_kind !== 'question' ||
      row.subject_id !== frozen.group_id ||
      parsed.data.job_id !== jobId ||
      data.question_id !== frozen.group_id ||
      data.revision_id !== frozen.revision_id ||
      data.expected_revision_digest !== frozen.revision_digest ||
      data.expected_admission_generation !== frozen.admission_generation ||
      parsed.data.question_id !== frozen.group_id ||
      parsed.data.revision_id !== frozen.revision_id ||
      parsed.data.revision_digest !== frozen.revision_digest ||
      parsed.data.source_event_id !== data.source_event_id ||
      parsed.data.usage_source_event_id !== (data.usage_source_event_id ?? null) ||
      row.caused_by_event_id !== parsed.data.usage_source_event_id
    )
      return false;
    bindings.push(parsed.data);
  }
  const [oldBinding, newBinding] = bindings;
  if (
    !oldBinding ||
    !newBinding ||
    oldBinding.source_event_id !== newBinding.source_event_id ||
    oldBinding.usage_source_event_id !== newBinding.usage_source_event_id
  )
    return false;
  const [publication] = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.id, oldBinding.source_event_id),
        eq(event.action, 'experimental:assessment_publish'),
        eq(event.outcome, 'success'),
      ),
    )
    .limit(1);
  if (
    publication?.payload.group_id !== frozen.group_id ||
    publication.subject_kind !== 'question' ||
    publication.subject_id !== frozen.group_id ||
    publication.payload.revision_id !== frozen.revision_id ||
    (publication.payload.integrity_digest !== undefined &&
      publication.payload.integrity_digest !== frozen.revision_digest)
  )
    return false;
  await tx.insert(event).values({
    id: mappingId(auth),
    actor_kind: 'system',
    actor_ref: ACTOR,
    action: ACTION,
    subject_kind: 'question',
    subject_id: frozen.group_id,
    outcome: 'success',
    caused_by_event_id: publication.id,
    ingest_at: new Date(),
    payload: Mapping.parse({
      version: 1,
      authorization_id: auth.authorization_id,
      original: originalIdentity(auth),
      original_delivery_id: auth.successor_delivery_id,
      successor: identity,
      successor_delivery_id: deliveryId,
      publication_id: publication.id,
      usage_source_event_id: oldBinding.usage_source_event_id,
    }),
  });
  return true;
}
