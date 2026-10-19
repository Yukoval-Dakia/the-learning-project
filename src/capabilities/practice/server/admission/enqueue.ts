import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { QUESTION_ADMISSION_CONTRACT_VERSION } from '@/core/question-admission-policy';
import { findAnswerShapeDeclarations } from '@/core/schema/assessment/blank-answer-shape';
import type { Db, Tx } from '@/db/client';
import { lockPaidEffectControlFamily, readPaidEffectControl } from '@/db/paid-effect-control';
import { event, question, question_group_lifecycle, question_revision } from '@/db/schema';
import type { EventSubscriptionDelivery, EventSubscriptionOutcome } from '@/kernel/manifest';
import { getPracticeBoss, practiceBossTransaction } from '../queue-runtime';

export const ADMISSION_FAMILY = 'question_admission_run';
export const AdmissionJobData = z.object({
  /** Absent on old queued deliveries: they may reconcile old units but never initiate @3. */
  admission_version: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  /** Lead-only authorization: the exact old paid-effect row identity (unit +
   *  input digest) one marked @3 send may re-open; ordinary publishers omit it. */
  reopen_paid_effect_identity: z
    .strictObject({
      unit: z.literal('admission@2'),
      input_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    })
    .optional(),
  question_id: z.string().min(1).optional(),
  revision_id: z.string().min(1).optional(),
  expected_revision_digest: z.string().min(1).optional(),
  expected_admission_generation: z.number().int().nonnegative().optional(),
  dispatch_generation: z.number().int().nonnegative().optional(),
});
export type AdmissionJobData = z.infer<typeof AdmissionJobData>;

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
  reopenMarkedInputDigest?: string,
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
        ...(reopenMarkedInputDigest ? [reopenMarkedInputDigest] : []),
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
    // YUK-1568（R1 P1-1）：声明 answer_shape 的题在本片没有已准入的数学
    // 比较器（第 2 片接入）—— 付费双解必须在比较器之前被拦。enqueue 前按
    // 冻结 revision 探测声明（宽松存在性检查：未知版本也算已声明），命中即
    // skip 不入队，不给后续 claim/maySend 留第一入口。
    if (findAnswerShapeDeclarations(revision.response_spec).length > 0) {
      return {
        status: 'skipped',
        reason: `declared answer_shape — comparator pending (YUK-1568 slice 2); revision ${revision.revision_id}`,
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
    const enqueued = await boss.send(
      ADMISSION_FAMILY,
      {
        admission_version: QUESTION_ADMISSION_CONTRACT_VERSION,
        question_id: root.id,
        revision_id: revision.revision_id,
        expected_revision_digest: revision.integrity_digest,
        expected_admission_generation: lifecycle.scoring_admission_generation,
        dispatch_generation: control.generation,
      } satisfies AdmissionJobData,
      { id, db: practiceBossTransaction(tx) },
    );
    if (enqueued === null)
      return { status: 'skipped', reason: `admission job already exists: ${id}` };
    return {
      status: 'succeeded',
      detail: { group_id: root.id, revision_id: revision.revision_id, job_id: id },
    };
  });
}

export const buildQuestionAdmissionSubscriber = (db: Db) => (delivery: EventSubscriptionDelivery) =>
  enqueuePublishedQuestionAdmission(db, delivery);
