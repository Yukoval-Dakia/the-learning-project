// Bounded re-drive for a 'pending' admission verdict. The paid send happened
// but produced nothing publishable, so the effect is marked 'unknown' — and the
// protocol never replays an 'unknown' row in place. The re-drive retires it
// through the generic void + successor authorization: the successor is the
// SAME frozen input plus a redrive coordinate (a new input digest, hence a new
// paid identity — every re-drive is an explicitly authorized fresh spend, not
// a replay of the failed one), bound to exactly one new deterministic job id
// enqueued with a minute-level startAfter. mark → void → authorize → enqueue
// commit in the caller's ONE transaction, so a crash can never mint a
// successor without its bound delivery or lose the delivery the
// authorization names.

import { createHash } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import type { PaidEffectIdentity } from '@/core/migration/paid-effect-protocol';
import { QUESTION_ADMISSION_CONTRACT_VERSION } from '@/core/question-admission-policy';
import type { Tx } from '@/db/client';
import { readPaidEffectControl } from '@/db/paid-effect-control';
import { voidPaidEffectWithSuccessor } from '@/db/paid-effect-store';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { ADMISSION_FAMILY, type AdmissionJobData } from './enqueue';
import type { FrozenAdmissionInput } from './receipt';

/** Original + at most this many authorized re-sends per admission batch. */
export const ADMISSION_REDRIVE_MAX_ATTEMPTS = 3;

/** Minute-level exponential backoff: 2, 4, 8 minutes, capped at 30. */
export function admissionRedriveDelaySeconds(nextAttempt: number): number {
  return Math.min(120 * 2 ** (nextAttempt - 1), 1800);
}

/**
 * Deterministic job id for the bound successor delivery (same hash→uuid
 * shaping as admissionJobId). Seeded on the VOIDED row's digest + attempt, so
 * a re-send after a lost enqueue collides on the PK and adds nothing.
 */
export function admissionRedriveJobId(voided: PaidEffectIdentity, nextAttempt: number): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([ADMISSION_FAMILY, 'redrive', voided.inputDigest, nextAttempt]))
    .digest('hex');
  const value = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * Retire the 'unknown' effect and bind its ONE successor delivery. Runs inside
 * the caller's transaction AFTER markPaidEffectUnknown (family advisory →
 * identity row → entity advisory, the protocol's pinned order). The successor
 * job is enqueued through the same transaction, so the bound delivery exists
 * iff the authorization does. Returns the successor job id + delay for audit.
 */
export async function scheduleAdmissionPendingRedrive(
  tx: Tx,
  args: {
    boss: PgBoss;
    /** The 'unknown' effect just marked by this run (same fence read at claim). */
    identity: PaidEffectIdentity;
    /** The frozen input of the voided batch; the redrive coordinate is added here. */
    input: FrozenAdmissionInput;
    fence: number;
    /** The delivery whose send just ended pending — recorded as `of_delivery`. */
    deliveryId: string;
    /** Original job envelope; only source/provenance fields carry forward. */
    jobData: AdmissionJobData;
    nextAttempt: number;
  },
): Promise<{ jobId: string; startAfterSeconds: number }> {
  const jobId = admissionRedriveJobId(args.identity, args.nextAttempt);
  const control = await readPaidEffectControl(tx, ADMISSION_FAMILY);
  const successorInput: FrozenAdmissionInput = {
    ...args.input,
    redrive: { attempt: args.nextAttempt, of_delivery: args.deliveryId },
  };
  await voidPaidEffectWithSuccessor(tx, args.identity, {
    expectedFence: args.fence,
    authorization: {
      authorizationId: `admission-redrive:${args.identity.inputDigest}:${args.nextAttempt}`,
      reason: 'admission_pending_redrive',
      operator: 'practice:question_admission',
      basis: 'bounded re-drive of an unsealed pending verdict over the same frozen input',
      successorInput: {
        family: ADMISSION_FAMILY,
        entityId: args.identity.entityId,
        entityRevision: args.identity.entityRevision,
        unit: args.identity.unit,
        input: successorInput,
      },
      successorDelivery: { backend: 'pg-boss', deliveryId: jobId },
    },
  });
  const startAfterSeconds = admissionRedriveDelaySeconds(args.nextAttempt);
  const jobData: AdmissionJobData = {
    admission_version: QUESTION_ADMISSION_CONTRACT_VERSION,
    question_id: args.input.group_id,
    ...(args.input.revision_id != null ? { revision_id: args.input.revision_id } : {}),
    ...(args.input.revision_digest != null
      ? { expected_revision_digest: args.input.revision_digest }
      : {}),
    expected_admission_generation: args.input.admission_generation,
    dispatch_generation: control.generation,
    ...(args.jobData.source_event_id != null
      ? { source_event_id: args.jobData.source_event_id }
      : {}),
    ...(args.jobData.usage_source_event_id != null
      ? { usage_source_event_id: args.jobData.usage_source_event_id }
      : {}),
    redrive_attempt: args.nextAttempt,
  };
  await args.boss.send(ADMISSION_FAMILY, jobData, {
    id: jobId,
    startAfter: startAfterSeconds,
    db: fromPgBossDrizzleTx(tx),
  });
  return { jobId, startAfterSeconds };
}
