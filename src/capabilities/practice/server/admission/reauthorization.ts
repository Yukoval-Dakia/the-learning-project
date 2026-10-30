// admission-specific surface of the generic paid-effect void +
// successor reauthorization. Shared by the reopen planning CLI (evaluate,
// freeze) and the backlog driver (verify, release ONE group inside its
// per-question gate, recover after a crash). Nothing here family-codes to a
// task list: every target arrives as explicit data.
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ADMISSION_FAMILY,
  type AdmissionJobData,
  admissionJobId,
  lockAdmissionGroup,
} from '@/capabilities/practice/server/admission/enqueue';
import { FrozenAdmissionInput } from '@/capabilities/practice/server/admission/receipt';
import { resolveQuestionAdmissionPolicyId } from '@/capabilities/practice/server/admission/run-admission';
import {
  type getPracticeBoss,
  practiceBossTransaction,
} from '@/capabilities/practice/server/queue-runtime';
import {
  type PaidEffectVoidAuthorization,
  computePaidEffectIdentity,
} from '@/core/migration/paid-effect-protocol';
import { QUESTION_ADMISSION_POLICY_IDS } from '@/core/question-admission-policy';
import type { Db, Tx } from '@/db/client';
import { voidPaidEffectWithSuccessor } from '@/db/paid-effect-store';

export const ADMISSION_VOID_ACTOR_REF = 'owner:yuk1547-approved-reopen';
const ENQUEUE_SUBSCRIBER_ID = 'practice.question-admission-enqueue';
const PUBLISH_ACTION = 'experimental:assessment_publish';

/** One group's void + successor spec — explicit row identities + fence CAS. */
export interface AdmissionVoidGroupSpec {
  groupId: string;
  baseDigest: string;
  successorUnit: string;
  void: { unit: string; inputDigest: string; expectedFence: number }[];
}

export interface AdmissionVoidEval {
  failures: string[];
  revisionId: string | null;
  availability: 'general_pool' | 'container_only' | null;
  withheldReason: string | null;
  baseGeneration: number;
  republishGenerations: number[];
  ghostGenerations: number[];
  finalGeneration: number;
  contractLayers: Record<string, unknown> | null;
  successorInput: FrozenAdmissionInput | null;
  successorInputDigest: string | null;
  jobId: string | null;
  ghostJobIds: string[];
}

type PracticeBoss = Awaited<ReturnType<typeof getPracticeBoss>>;

/**
 * Freeze the successor's FrozenAdmissionInput exactly the way the job derives
 * it at claim time — same seal layers, profile, resolved policy and solver2
 * env. The digest computed here is what the authorization binds and what the
 * release drift-check re-verifies before any write.
 */
async function buildSuccessorInput(
  tx: Tx,
  opts: {
    groupId: string;
    baseDigest: string;
    revisionId: string;
    generation: number;
    unit: string;
  },
): Promise<{
  input: FrozenAdmissionInput;
  identity: ReturnType<typeof computePaidEffectIdentity>;
  contractLayers: Record<string, unknown>;
}> {
  const { knowledge, question, question_revision } = await import('@/db/schema');
  const { publishedContractSeal, publishedSealAccepts } = await import(
    '@/kernel/records/assessment-normalization'
  );
  // Strictly-live subject resolution lives in the kernel read-model (shared
  // hydration engine; capability files may not deep-import server/subjects):
  // hydrates a private registry inside this transaction context and requires
  // every bound trait to be a live DB payload — a paid input must never bind
  // code-floor / journal_fallback / code_seed / general-fallback content.
  const { resolveSubjectProfileStrictLive } = await import('@/kernel/read-models/subject-profile');
  const [revision] = await tx
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, opts.revisionId));
  if (!revision) throw new Error('revision missing while freezing the successor input');
  const seal = publishedContractSeal({
    structure: revision.structure,
    response_spec: revision.response_spec,
    scoring_basis: revision.scoring_basis,
    execution_plan: revision.execution_plan,
    ...(revision.presentation != null ? { presentation: revision.presentation } : {}),
  });
  if (!publishedSealAccepts(seal, revision.integrity_digest)) {
    throw new Error('revision layers no longer seal to the stored digest');
  }
  const [row] = await tx
    .select({ knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(eq(question.id, opts.groupId))
    .limit(1);
  const first = row?.knowledge_ids?.[0];
  const [node] = first
    ? await tx
        .select({ domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, first))
        .limit(1)
    : [undefined];
  const solver2Provider = process.env.QUESTION_ADMISSION_SOLVER2_PROVIDER;
  const solver2Model = process.env.QUESTION_ADMISSION_SOLVER2_MODEL;
  const input = FrozenAdmissionInput.parse(
    JSON.parse(
      JSON.stringify({
        version: 1,
        group_id: opts.groupId,
        revision_id: opts.revisionId,
        revision_digest: opts.baseDigest,
        admission_generation: opts.generation,
        contract: {
          ...seal.parsed,
          integrity_digest: opts.baseDigest,
          group_id: opts.groupId,
          conversion_issues: [],
        },
        subject_profile: await resolveSubjectProfileStrictLive(tx, node?.domain ?? null),
        policy_id: resolveQuestionAdmissionPolicyId(),
        solver2:
          solver2Provider || solver2Model
            ? { provider: solver2Provider, model: solver2Model }
            : null,
      }),
    ),
  );
  const identity = computePaidEffectIdentity({
    family: ADMISSION_FAMILY,
    entityId: opts.groupId,
    entityRevision: opts.baseDigest,
    unit: opts.unit,
    input,
  });
  return { input, identity, contractLayers: seal.parsed as Record<string, unknown> };
}

/**
 * THE eligibility predicate shared by planning (read-only) and release
 * (re-verified under the same locks before any write). A group is eligible
 * only when the spec names EVERY 'unknown' paid row on the entity with
 * matching fences, no active/in-flight send exists for it anywhere (sending
 * row, pending intent, receipt owed application, live job, unsettled
 * enqueue-subscription delivery, undiscovered publish event), no applied
 * verdict or terminal verification would resolve the claim without a send,
 * and the current revision still seals to the manifest's base digest.
 * Historical 'voided' rows and applied verdicts on OTHER bases pass.
 */
export async function evaluateAdmissionVoidGroup(
  tx: Tx,
  spec: AdmissionVoidGroupSpec,
): Promise<AdmissionVoidEval> {
  const failures: string[] = [];
  const { paid_effect, question_admission_verification, question_revision } = await import(
    '@/db/schema'
  );
  const resolvedPolicy = resolveQuestionAdmissionPolicyId();
  const evalResult: AdmissionVoidEval = {
    failures,
    revisionId: null,
    availability: null,
    withheldReason: null,
    baseGeneration: 0,
    republishGenerations: [],
    ghostGenerations: [],
    finalGeneration: 0,
    contractLayers: null,
    successorInput: null,
    successorInputDigest: null,
    jobId: null,
    ghostJobIds: [],
  };
  const { root, lifecycle } = await lockAdmissionGroup(tx, spec.groupId);
  if (!root) {
    failures.push('group root missing');
    return evalResult;
  }
  if (root.parent_question_id !== null) failures.push('not a group root');
  if (!lifecycle) {
    failures.push('lifecycle missing');
    return evalResult;
  }
  if (lifecycle.withdrawn) failures.push('withdrawn');
  if (lifecycle.suspended) failures.push('suspended');
  if (lifecycle.scoring_admission_state !== 'withheld') {
    failures.push(`lifecycle '${lifecycle.scoring_admission_state}' is not withheld`);
  }
  if (!lifecycle.current_revision_id) failures.push('no current revision');
  const [revision] = lifecycle.current_revision_id
    ? await tx
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, lifecycle.current_revision_id))
    : [];
  if (!revision || revision.group_id !== spec.groupId) {
    failures.push('current revision missing or belongs to another group');
  } else if (revision.integrity_digest !== spec.baseDigest) {
    failures.push('current revision digest != manifest base_digest');
  } else {
    evalResult.revisionId = revision.revision_id;
  }
  // Every paid row on the entity is accounted for: named 'unknown' rows are
  // voided, historical 'voided' rows stay, applied verdicts on OTHER bases are
  // out of scope — everything else blocks the reauthorization.
  const effects = await tx
    .select()
    .from(paid_effect)
    .where(and(eq(paid_effect.family, ADMISSION_FAMILY), eq(paid_effect.entity_id, spec.groupId)))
    .for('update');
  const voidKeys = new Set(spec.void.map((v) => `${v.unit}|${v.inputDigest}`));
  if (voidKeys.size !== spec.void.length) {
    failures.push('manifest void list contains duplicate targets');
  }
  const seen = new Set<string>();
  for (const effect of effects) {
    const key = `${effect.unit}|${effect.input_digest}`;
    const target = spec.void.find(
      (v) => v.unit === effect.unit && v.inputDigest === effect.input_digest,
    );
    if (target) {
      seen.add(key);
      if (effect.state !== 'unknown') {
        failures.push(`void target ${key} is '${effect.state}', not 'unknown'`);
      } else if (effect.fence !== target.expectedFence) {
        failures.push(
          `void target ${key} fence ${effect.fence} != expected_fence ${target.expectedFence}`,
        );
      }
      continue;
    }
    // Resolved history never blocks a reauthorization: 'voided' rows are
    // retired obligations and 'cancelled' rows are sealed never-sent intents
    // neither owes a send nor an application.
    if (effect.state === 'voided' || effect.state === 'cancelled') continue;
    if (effect.state === 'applied' && effect.entity_revision !== spec.baseDigest) continue;
    if (effect.state === 'applied') {
      failures.push(`terminal applied verdict on base: ${key}`);
    } else {
      failures.push(`uncovered '${effect.state}' paid row on entity: ${key}`);
    }
  }
  for (const v of spec.void) {
    if (!seen.has(`${v.unit}|${v.inputDigest}`)) {
      failures.push(`manifest void target missing: ${v.unit}|${v.inputDigest}`);
    }
  }
  // No in-flight work may exist for the group: live jobs, unsettled
  // enqueue-subscription deliveries and undiscovered eligible publish events
  // all mean a send could still be racing the void.
  const liveJobs = await tx.execute<{ id: string }>(sql`
    select id from pgboss.job
    where name = ${ADMISSION_FAMILY} and data->>'question_id' = ${spec.groupId}
      and state in ('created','retry','active')`);
  if (liveJobs.length > 0) {
    failures.push(`non-terminal admission job(s): ${liveJobs.map((j) => j.id).join(',')}`);
  }
  const deliveries = await tx.execute<{ source_event_id: string; status: string }>(sql`
    select d.source_event_id, d.status::text as status
    from event_subscription_delivery d
    join event e on e.id = d.source_event_id and e.dispatch_seq = d.source_dispatch_seq
    where d.subscriber_id = ${ENQUEUE_SUBSCRIBER_ID}
      and d.status not in ('bootstrap_skipped','succeeded','skipped','dead_letter')
      and e.payload->>'group_id' = ${spec.groupId}`);
  if (deliveries.length > 0) {
    failures.push(
      `unsettled enqueue deliveries: ${deliveries.map((d) => `${d.source_event_id}:${d.status}`).join(',')}`,
    );
  }
  const undiscovered = await tx.execute<{ id: string }>(sql`
    select e.id from event e
    where e.action = ${PUBLISH_ACTION} and e.outcome = 'success'
      and e.actor_ref <> 'practice:question_admission'
      and e.payload->>'admission' = 'withheld'
      and e.payload->>'group_id' = ${spec.groupId}
      and not exists (
        select 1 from event_subscription_delivery d
        where d.subscriber_id = ${ENQUEUE_SUBSCRIBER_ID} and d.source_event_id = e.id)`);
  if (undiscovered.length > 0) {
    failures.push(
      `undiscovered eligible publish events: ${undiscovered.map((e2) => e2.id).join(',')}`,
    );
  }
  const [terminal] = await tx
    .select({ id: question_admission_verification.id })
    .from(question_admission_verification)
    .innerJoin(
      question_revision,
      eq(question_admission_verification.revision_id, question_revision.revision_id),
    )
    .where(
      and(
        eq(question_revision.group_id, spec.groupId),
        inArray(question_admission_verification.policy_id, [
          ...QUESTION_ADMISSION_POLICY_IDS,
          resolvedPolicy,
        ]),
        sql`${question_admission_verification.evidence}->>'pack' = 'question_admission'`,
        sql`${question_admission_verification.evidence}->>'base_contract_digest' = ${spec.baseDigest}`,
        inArray(question_admission_verification.outcome, ['passed', 'failed', 'suspended']),
      ),
    )
    .limit(1);
  if (terminal) {
    failures.push('terminal admission verification on base — the claim would resolve historical');
  }
  if (failures.length === 0 && revision && lifecycle.current_revision_id) {
    const base = lifecycle.scoring_admission_generation;
    evalResult.baseGeneration = base;
    evalResult.withheldReason = lifecycle.scoring_admission_withheld_reason;
    evalResult.availability = lifecycle.availability;
    // Re-pend bumps generation once per admission update: owner_hold first
    // (skipped when already owner_hold), then unverified_rules — mirroring the
    // retired reopen exactly. Each emitted event is subscriber-visible.
    const dual = lifecycle.scoring_admission_withheld_reason !== 'owner_hold';
    evalResult.republishGenerations = dual ? [base + 1, base + 2] : [base + 1];
    evalResult.finalGeneration = base + evalResult.republishGenerations.length;
    evalResult.ghostGenerations = evalResult.republishGenerations.slice(0, -1);
    try {
      const successor = await buildSuccessorInput(tx, {
        groupId: spec.groupId,
        baseDigest: spec.baseDigest,
        revisionId: revision.revision_id,
        generation: evalResult.finalGeneration,
        unit: spec.successorUnit,
      });
      evalResult.contractLayers = successor.contractLayers;
      evalResult.successorInput = successor.input;
      evalResult.successorInputDigest = successor.identity.inputDigest;
    } catch (error) {
      failures.push(
        `successor input freeze failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return evalResult;
    }
    evalResult.jobId = admissionJobId(
      spec.groupId,
      revision.revision_id,
      spec.baseDigest,
      evalResult.finalGeneration,
    );
    evalResult.ghostJobIds = evalResult.ghostGenerations.map((generation) =>
      admissionJobId(spec.groupId, revision.revision_id, spec.baseDigest, generation),
    );
  }
  return evalResult;
}

export interface AdmissionVoidRelease {
  jobId: string;
  revisionId: string;
  generation: number;
  events: { eventId: string; revisionId: string; admissionGeneration: number }[];
  ghostGenerations: number[];
}

/**
 * Release ONE authorized group inside the caller's transaction — the driver's
 * per-question gated step. Re-verifies the frozen spec under the family lock,
 * re-pends the lifecycle (republish bump), enqueues the single bound job, and
 * voids every named 'unknown' row while binding them to this exact successor
 * + delivery. Any drift or partial failure aborts the whole release.
 */
export async function releaseAdmissionVoidSuccessor(
  tx: Tx,
  spec: AdmissionVoidGroupSpec,
  frozen: {
    finalGeneration: number;
    revisionId: string;
    successorInputDigest: string;
    jobId: string;
  },
  auth: Omit<PaidEffectVoidAuthorization, 'successorInput' | 'successorDelivery'>,
  boss: PracticeBoss,
): Promise<AdmissionVoidRelease> {
  const { lockPaidEffectControlFamily, readPaidEffectControl } = await import(
    '@/db/paid-effect-control'
  );
  const { publishQuestionGroup } = await import('@/kernel/records/assessment-publication');
  const { getR2 } = await import('@/kernel/object-storage');
  await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
  // Re-verify EVERYTHING under the locks the write will take — the frozen
  // plan's fences/identity digests must still hold or the release aborts.
  const fresh = await evaluateAdmissionVoidGroup(tx, spec);
  if (fresh.failures.length > 0) {
    throw new Error(
      `${spec.groupId}: void release re-verification failed: ${fresh.failures.join('; ')}`,
    );
  }
  if (
    fresh.finalGeneration !== frozen.finalGeneration ||
    fresh.successorInputDigest !== frozen.successorInputDigest ||
    fresh.jobId !== frozen.jobId ||
    fresh.revisionId !== frozen.revisionId
  ) {
    throw new Error(`${spec.groupId}: plan drifted since freeze — re-run the planner`);
  }
  const control = await readPaidEffectControl(tx, ADMISSION_FAMILY);
  if (control.backend !== 'pg-boss') throw new Error('Admission producer fenced');
  const events: AdmissionVoidRelease['events'] = [];
  let generation = fresh.baseGeneration;
  for (const reason of ['owner_hold', 'unverified_rules'] as const) {
    if (reason === 'owner_hold' && fresh.withheldReason === 'owner_hold') continue;
    const published = await publishQuestionGroup(tx, {
      group_id: spec.groupId,
      contract: {
        ...(fresh.contractLayers ?? {}),
        integrity_digest: spec.baseDigest,
      } as Parameters<typeof publishQuestionGroup>[1]['contract'],
      expectedCurrentRevision: fresh.revisionId,
      expectedAdmissionGeneration: generation,
      availability: fresh.availability ?? 'general_pool',
      admission: { state: 'withheld', reason },
      actorRef: ADMISSION_VOID_ACTOR_REF,
      now: new Date(),
      readAssetBytes: (key) => getR2().get(key),
    });
    if (
      published.status !== 'admission_updated' ||
      published.current_revision_id !== fresh.revisionId
    ) {
      throw new Error('Reopen must be a dimension-only update');
    }
    generation = published.admission_generation;
    events.push({
      eventId: published.event_id,
      revisionId: published.current_revision_id ?? (fresh.revisionId as string),
      admissionGeneration: generation,
    });
  }
  if (generation !== frozen.finalGeneration) {
    throw new Error(`${spec.groupId}: republish generation drifted from the frozen plan`);
  }
  if (!fresh.successorInput) throw new Error(`${spec.groupId}: successor input missing`);
  const queued = await boss.send(
    ADMISSION_FAMILY,
    {
      admission_version: 3,
      question_id: spec.groupId,
      revision_id: fresh.revisionId ?? undefined,
      expected_revision_digest: spec.baseDigest,
      expected_admission_generation: generation,
      dispatch_generation: control.generation,
    } satisfies AdmissionJobData,
    { id: frozen.jobId, db: practiceBossTransaction(tx) },
  );
  if (queued === null) {
    throw new Error(`bound job ${frozen.jobId} already exists; inspect instead of replaying`);
  }
  // Void + authorize + admit the successor intent — inside this same
  // transaction so the reservation and the bound job commit together.
  for (const v of spec.void) {
    await voidPaidEffectWithSuccessor(
      tx,
      {
        family: ADMISSION_FAMILY,
        entityId: spec.groupId,
        entityRevision: spec.baseDigest,
        unit: v.unit,
        inputDigest: v.inputDigest,
      },
      {
        expectedFence: v.expectedFence,
        authorization: {
          authorizationId: auth.authorizationId,
          reason: auth.reason,
          operator: auth.operator,
          basis: auth.basis,
          successorInput: {
            family: ADMISSION_FAMILY,
            entityId: spec.groupId,
            entityRevision: spec.baseDigest,
            unit: spec.successorUnit,
            input: fresh.successorInput,
          },
          successorDelivery: { backend: 'pg-boss', deliveryId: frozen.jobId },
        },
      },
    );
  }
  return {
    jobId: frozen.jobId,
    revisionId: fresh.revisionId ?? '',
    generation,
    events,
    ghostGenerations: fresh.ghostGenerations,
  };
}

export interface AdmissionVoidRecovered extends AdmissionVoidRelease {
  sentAt: string;
}

/**
 * Post-commit recovery: if every named void row is already 'voided' under this
 * authorization, the release committed but the caller crashed before writing
 * its own artifacts — rebuild the publish record from the events table and
 * the bound job (never re-mutates). Returns null when the group is not yet
 * released; throws when rows are voided under a DIFFERENT authorization.
 */
export async function recoverAdmissionVoidSend(
  db: Db | Tx,
  spec: AdmissionVoidGroupSpec,
  frozen: {
    finalGeneration: number;
    revisionId: string;
    republishGenerations: number[];
    jobId: string;
  },
  authorizationId: string,
): Promise<AdmissionVoidRecovered | null> {
  const { paid_effect } = await import('@/db/schema');
  const rows = await db
    .select({
      unit: paid_effect.unit,
      input_digest: paid_effect.input_digest,
      state: paid_effect.state,
      voided_at: paid_effect.voided_at,
      void_json: paid_effect.void_json,
    })
    .from(paid_effect)
    .where(and(eq(paid_effect.family, ADMISSION_FAMILY), eq(paid_effect.entity_id, spec.groupId)));
  const voidedRows = spec.void.map((v) =>
    rows.find((r) => r.unit === v.unit && r.input_digest === v.inputDigest),
  );
  const released = voidedRows.every((row) => row?.state === 'voided');
  if (!released) return null;
  for (const [i, row] of voidedRows.entries()) {
    const receipt = row?.void_json as { authorizationId?: string } | null;
    if (receipt?.authorizationId !== authorizationId) {
      throw new Error(
        `${spec.groupId}: void target ${spec.void[i].unit}|${spec.void[i].inputDigest} is ` +
          `voided under a different authorization (${receipt?.authorizationId ?? '<missing>'})`,
      );
    }
  }
  const [job] = (await db.execute(
    sql`select id from pgboss.job where id = ${frozen.jobId}::uuid`,
  )) as unknown as { id: string }[];
  if (!job) throw new Error(`${spec.groupId}: bound job ${frozen.jobId} missing after commit`);
  const events = (await db.execute(sql`
    select e.id as event_id, e.payload->>'revision_id' as revision_id,
           e.payload->>'admission_generation' as admission_generation
    from event e
    where e.action = ${PUBLISH_ACTION} and e.outcome = 'success'
      and e.payload->>'group_id' = ${spec.groupId}
      and e.payload->>'revision_id' = ${frozen.revisionId}
      and e.payload->>'admission_generation' = any(${frozen.republishGenerations.map(String)}::text[])
    order by e.dispatch_seq`)) as unknown as {
    event_id: string;
    revision_id: string;
    admission_generation: string;
  }[];
  const sentAt = voidedRows.find((r) => r?.voided_at)?.voided_at;
  return {
    jobId: frozen.jobId,
    revisionId: frozen.revisionId,
    generation: frozen.finalGeneration,
    events: events.map((e) => ({
      eventId: e.event_id,
      revisionId: e.revision_id,
      admissionGeneration: Number(e.admission_generation),
    })),
    ghostGenerations: frozen.republishGenerations.slice(0, -1),
    sentAt: (sentAt ?? new Date()).toISOString(),
  };
}
