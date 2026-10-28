import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { QUESTION_ADMISSION_CONTRACT_VERSION } from '@/core/question-admission-policy';
import { declaredShapesAllSupported } from '@/core/schema/assessment/blank-answer-compare';
import type { Db, Tx } from '@/db/client';
import { lockPaidEffectControlFamily, readPaidEffectControl } from '@/db/paid-effect-control';
import { event, question, question_group_lifecycle, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  lockEventDerivationSources,
  readEventDerivationPolicy,
} from '@/kernel/events/derivation-policy';
import type { EventSubscriptionDelivery, EventSubscriptionOutcome } from '@/kernel/manifest';
import { getPracticeBoss, practiceBossTransaction } from '../queue-runtime';

export const ADMISSION_FAMILY = 'question_admission_run';
export const AdmissionJobData = z.object({
  /** Absent on old queued deliveries: they may reconcile old units but never initiate @3. */
  admission_version: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  question_id: z.string().min(1).optional(),
  revision_id: z.string().min(1).optional(),
  expected_revision_digest: z.string().min(1).optional(),
  expected_admission_generation: z.number().int().nonnegative().optional(),
  dispatch_generation: z.number().int().nonnegative().optional(),
  source_event_id: z.string().min(1).optional(),
  usage_source_event_id: z.string().min(1).optional(),
});
export type AdmissionJobData = z.infer<typeof AdmissionJobData>;

const AdmissionPurposeBinding = z
  .object({
    version: z.literal(1),
    job_id: z.string(),
    source_event_id: z.string(),
    usage_source_event_id: z.string().nullable(),
    question_id: z.string(),
    revision_id: z.string(),
    revision_digest: z.string(),
    derivation_policy: z.literal('answer_only'),
  })
  .strict();
const purposeBindingId = (jobId: string) => `question-admission-purpose:${jobId}`;

/** A delivery's permanent source fact is separate from its unchanged paid input.
 * Missing legacy facts are never reconstructed from today's publication or row.
 */
export async function readAdmissionPurpose(
  tx: Tx,
  deliveryId: string,
  expected: { group_id: string; revision_id: string | null; revision_digest: string | null },
  jobData?: AdmissionJobData,
) {
  const [row] = await tx
    .select()
    .from(event)
    .where(eq(event.id, purposeBindingId(deliveryId)));
  const parsed = AdmissionPurposeBinding.safeParse(row?.payload);
  if (
    !parsed.success ||
    row?.action !== 'experimental:question_admission_purpose' ||
    row.actor_kind !== 'system' ||
    row.actor_ref !== 'practice:question_admission' ||
    parsed.data.job_id !== deliveryId ||
    parsed.data.question_id !== expected.group_id ||
    parsed.data.revision_id !== expected.revision_id ||
    parsed.data.revision_digest !== expected.revision_digest ||
    (jobData &&
      (jobData.source_event_id !== parsed.data.source_event_id ||
        (jobData.usage_source_event_id ?? null) !== parsed.data.usage_source_event_id))
  )
    return { state: 'unknown' as const, sourceId: null };
  const binding = parsed.data;
  const [publication] = await tx.select().from(event).where(eq(event.id, binding.source_event_id));
  if (
    publication?.action !== 'experimental:assessment_publish' ||
    publication.outcome !== 'success' ||
    publication.payload.group_id !== expected.group_id ||
    publication.payload.revision_id !== expected.revision_id ||
    (publication.payload.integrity_digest !== undefined &&
      publication.payload.integrity_digest !== expected.revision_digest)
  )
    return { state: 'unknown' as const, sourceId: null };
  const sourceId = binding.usage_source_event_id;
  if (!sourceId) return { state: 'unknown' as const, sourceId: null };
  const [source] = await tx.select().from(event).where(eq(event.id, sourceId));
  if (!source || row.caused_by_event_id !== sourceId)
    return { state: 'unknown' as const, sourceId: null };
  if (sourceId !== publication.id) {
    const receipt = source.payload.receipt as Record<string, unknown> | undefined;
    if (
      source.action !== 'experimental:question_draft_submit' ||
      source.outcome !== 'success' ||
      receipt?.publish_status !== 'published' ||
      receipt.revision_id !== expected.revision_id ||
      !['admitted', 'withheld', 'pending'].includes(String(receipt.status)) ||
      publication.actor_ref !== `submit_question:${source.actor_ref}` ||
      (receipt.group_id ?? receipt.question_id) !== expected.group_id
    )
      return { state: 'unknown' as const, sourceId: null };
  }
  // A real session (including a non-Ingestion session) or immutable document
  // binding proves provenance. A publisher id with empty source fields does not.
  const [proven] = await tx.execute<{ known: boolean }>(sql`WITH RECURSIVE lineage AS (
    SELECT id, session_id, caused_by_event_id FROM event WHERE id = ${sourceId}
    UNION SELECT p.id, p.session_id, p.caused_by_event_id FROM event p
      JOIN lineage c ON c.caused_by_event_id = p.id
  ) SELECT EXISTS(SELECT 1 FROM lineage l LEFT JOIN learning_session s ON s.id = l.session_id
      LEFT JOIN event b ON b.id = 'ingestion-usage:' || l.id
      WHERE (s.id IS NOT NULL AND (s.type <> 'ingestion' OR s.source_document_id IS NOT NULL))
        OR (b.action = 'experimental:ingestion_usage_binding'
        AND b.actor_kind = 'system' AND b.actor_ref = 'ingestion-usage')) AS known`);
  if (!proven?.known) return { state: 'unknown' as const, sourceId };
  await lockEventDerivationSources(tx, sourceId);
  const allowed =
    (await readEventDerivationPolicy(tx, sourceId)) === 'allow' &&
    (await readEventDerivationPolicy(tx, publication.id)) === 'allow';
  return { state: allowed ? ('allow' as const) : ('restricted' as const), sourceId };
}

/** Publisher lock order: group root, then lifecycle. No network effects in this transaction. */
export async function lockAdmissionGroup(tx: Tx, groupId: string) {
  const [root] = await tx.select().from(question).where(eq(question.id, groupId)).for('update');
  const [lifecycle] = await tx
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupId))
    .for('update');
  return { root, lifecycle };
}

export function isPendingAdmission(
  lifecycle: typeof question_group_lifecycle.$inferSelect | undefined,
) {
  return (
    lifecycle?.scoring_admission_state === 'withheld' &&
    lifecycle.scoring_admission_withheld_reason === 'unverified_rules' &&
    !lifecycle.withdrawn &&
    !lifecycle.suspended
  );
}

export function admissionJobId(
  groupId: string,
  revisionId: string,
  digest: string,
  generation: number,
): string {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        ADMISSION_FAMILY,
        QUESTION_ADMISSION_CONTRACT_VERSION,
        groupId,
        revisionId,
        digest,
        generation,
      ]),
    )
    .digest('hex');
  const value = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * Existing subscription bootstrap skips history; only newly committed publisher events enter.
 * The event is the transactional outbox, not a new scanner or a second publisher hook.
 */
export async function enqueuePublishedQuestionAdmission(
  db: Db,
  delivery: EventSubscriptionDelivery,
): Promise<EventSubscriptionOutcome> {
  const boss = await getPracticeBoss();
  return db.transaction(async (tx) => {
    await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
    const [source] = await tx.select().from(event).where(eq(event.id, delivery.sourceEventId));
    const payload = z
      .object({ group_id: z.string(), revision_id: z.string(), admission: z.string() })
      .safeParse(source?.payload);
    if (
      source?.action !== 'experimental:assessment_publish' ||
      source.outcome !== 'success' ||
      source.actor_ref === 'practice:question_admission' ||
      !payload.success ||
      payload.data.admission !== 'withheld'
    ) {
      return { status: 'skipped', reason: 'not a pending admission publication' };
    }
    const { root, lifecycle } = await lockAdmissionGroup(tx, payload.data.group_id);
    if (
      !root ||
      root.parent_question_id !== null ||
      !lifecycle ||
      !isPendingAdmission(lifecycle) ||
      lifecycle.current_revision_id !== payload.data.revision_id
    ) {
      return { status: 'skipped', reason: 'publication is no longer current and pending' };
    }
    const [revision] = await tx
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, payload.data.revision_id));
    if (!revision || revision.group_id !== root.id)
      throw new Error('Admission revision binding missing');
    // （第 2 片）：声明 answer_shape 的题由共享比较核心判定支持后
    // 才可进入付费双解 —— 未实现 notation、未知/坏声明仍在入队前被拦（宽
    // 松存在性扫描 + declaredShapesAllSupported：未知版本也算已声明并判
    // 未支持）。命中即 skip 不入队，不给后续 claim/maySend 留第一入口。
    const declaredSupport = declaredShapesAllSupported(revision.response_spec);
    if (!declaredSupport.ok) {
      return {
        status: 'skipped',
        reason: `declared answer_shape unsupported: ${declaredSupport.reason}; revision ${revision.revision_id}`,
      };
    }
    const control = await readPaidEffectControl(tx, ADMISSION_FAMILY);
    if (control.backend !== 'pg-boss')
      throw new Error('Question admission pg-boss producer is fenced');
    const id = admissionJobId(
      root.id,
      revision.revision_id,
      revision.integrity_digest,
      lifecycle.scoring_admission_generation,
    );
    // Exact immutable first-publication receipt only. Multiple receipts, no-op
    // submissions and legacy unbound envelopes cannot supply a guessed source.
    const receipts = await tx
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:question_draft_submit'),
          eq(event.outcome, 'success'),
          sql`${event.payload}->'receipt'->>'revision_id' = ${revision.revision_id}`,
          sql`coalesce(${event.payload}->'receipt'->>'group_id', ${event.payload}->'receipt'->>'question_id') = ${root.id}`,
          sql`${event.payload}->'receipt'->>'publish_status' = 'published'`,
          sql`${event.payload}->'receipt'->>'status' IN ('admitted', 'withheld', 'pending')`,
          sql`'submit_question:' || ${event.actor_ref} = ${source.actor_ref}`,
        ),
      )
      .limit(2);
    const usageSourceId =
      source.session_id || source.caused_by_event_id
        ? source.id
        : receipts.length === 1
          ? receipts[0].id
          : null;
    if (usageSourceId) {
      await lockEventDerivationSources(tx, usageSourceId);
      if (
        (await readEventDerivationPolicy(tx, usageSourceId)) !== 'allow' ||
        (await readEventDerivationPolicy(tx, source.id)) !== 'allow'
      )
        return { status: 'skipped', reason: 'original publication source purpose restricted' };
    }
    const enqueued = await boss.send(
      ADMISSION_FAMILY,
      {
        admission_version: QUESTION_ADMISSION_CONTRACT_VERSION,
        question_id: root.id,
        revision_id: revision.revision_id,
        expected_revision_digest: revision.integrity_digest,
        expected_admission_generation: lifecycle.scoring_admission_generation,
        dispatch_generation: control.generation,
        source_event_id: source.id,
        ...(usageSourceId ? { usage_source_event_id: usageSourceId } : {}),
      } satisfies AdmissionJobData,
      { id, db: practiceBossTransaction(tx) },
    );
    if (enqueued === null)
      return { status: 'skipped', reason: `admission job already exists: ${id}` };
    await writeEvent(tx, {
      id: purposeBindingId(id),
      actor_kind: 'system',
      actor_ref: 'practice:question_admission',
      action: 'experimental:question_admission_purpose',
      subject_kind: 'question',
      subject_id: root.id,
      caused_by_event_id: usageSourceId,
      payload: AdmissionPurposeBinding.parse({
        version: 1,
        job_id: id,
        source_event_id: source.id,
        usage_source_event_id: usageSourceId,
        question_id: root.id,
        revision_id: revision.revision_id,
        revision_digest: revision.integrity_digest,
        derivation_policy: 'answer_only',
      }),
      affected_scopes: [],
      ingest_at: new Date(),
    });
    return {
      status: 'succeeded',
      detail: { group_id: root.id, revision_id: revision.revision_id, job_id: id },
    };
  });
}

export const buildQuestionAdmissionSubscriber = (db: Db) => (delivery: EventSubscriptionDelivery) =>
  enqueuePublishedQuestionAdmission(db, delivery);
