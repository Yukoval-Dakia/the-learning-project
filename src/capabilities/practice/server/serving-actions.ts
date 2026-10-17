// YUK-1514 — question serving release commands.
//
// POST /api/questions/[id]/serving-actions/{command} execution core. Three
// owner commands release a held question through EXISTING seams only:
//
//   reverify            — re-enqueue the question_admission_run batch through
//                         #1752's publish-event mechanism. A group withheld for
//                         a non-pending reason is first re-pended
//                         (withheld → unverified_rules, dimension-only publish:
//                         same digest ⇒ admission_updated, generation+1) so the
//                         new publish event itself is a valid enqueue source;
//                         its paid_effect claim still decides whether the
//                         identical base is ever paid again. When the canonical
//                         enqueue dedups (same deterministic job id) yet no job
//                         is in-flight, a manual fresh-id re-dispatch onto the
//                         same family queue replays the claim under locks —
//                         still never a second pay for an applied batch.
//   recheck_source      — re-dispatch source_verify onto the same pg-boss queue
//                         the verify-dispatch outbox drains to. The outbox's
//                         intent ledger is per-(verifier,question) first-write-
//                         wins, so a re-check cannot ride a new intent; the
//                         command event IS the durable record and
//                         runSourceVerify's own terminal-event guard decides
//                         whether a real (error-only) re-run happens.
//   release_verify_hold — synchronous: clear suspension through the publisher's
//                         dimension-only path with the CURRENT revision's stored
//                         contract (#1753 pattern — digest unchanged ⇒
//                         admission_updated, never a new revision). The seam's
//                         suspension resolver never clears retraction_hold.
//
// Every command writes exactly one experimental:question_serving_action event
// keyed by Idempotency-Key; a replay returns the recorded accepted flag with a
// freshly derived serving projection.

import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { readPaidEffectControl } from '@/db/paid-effect-control';
import { event, question, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  AWAITING_ADMISSION_REVERIFY_AFTER_MS,
  type QuestionServing,
  SERVING_ACTION_EVENT_ACTION,
  SERVING_SOURCE_VERIFY_JOB,
  type ServingActionCommand,
  readQuestionServing,
} from '@/kernel/read-models/question-serving';
import type { WithheldReason } from '@/server/questions/publisher';
import {
  ADMISSION_FAMILY,
  type AdmissionJobData,
  enqueuePublishedQuestionAdmission,
  lockAdmissionGroup,
} from './admission/enqueue';
import { getPracticeBoss } from './queue-runtime';
import { publishQuestionGroup } from './quiz/verify-and-promote';

const ACTOR_REF = 'practice:serving_actions';

/** Deterministic command-event id — Idempotency-Key replay lands on the same row. */
function servingActionEventId(
  groupId: string,
  command: ServingActionCommand,
  idempotencyKey: string,
): string {
  const digest = createHash('sha256').update(`${groupId}${command}${idempotencyKey}`).digest('hex');
  return `qsact_${digest.slice(0, 48)}`;
}

async function findServingActionEvent(
  db: Db | Tx,
  eventId: string,
): Promise<{ accepted: boolean } | null> {
  const [row] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, eventId))
    .limit(1);
  if (row == null) return null;
  const payload = row.payload as Record<string, unknown> | null;
  return { accepted: payload?.accepted === true };
}

async function writeServingActionEvent(
  tx: Tx,
  input: {
    eventId: string;
    groupId: string;
    command: ServingActionCommand;
    idempotencyKey: string;
    accepted: boolean;
    holdReason: string | null;
    detail?: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await writeEvent(tx, {
    id: input.eventId,
    actor_kind: 'user',
    actor_ref: ACTOR_REF,
    action: SERVING_ACTION_EVENT_ACTION,
    subject_kind: 'question',
    subject_id: input.groupId,
    outcome: input.accepted ? 'success' : 'failure',
    payload: {
      command: input.command,
      idempotency_key: input.idempotencyKey,
      question_id: input.groupId,
      accepted: input.accepted,
      hold_reason: input.holdReason,
      ...(input.detail ?? {}),
    },
    created_at: input.now,
    ingest_at: input.now,
  });
}

/** In-flight question_admission_run job for the group (created/retry/active). */
async function admissionJobInFlight(db: Db | Tx, groupId: string): Promise<boolean> {
  const rows = await db.execute<{ name: string }>(sql`
    select name from pgboss.job
    where name = ${ADMISSION_FAMILY}
      and data->>'question_id' = ${groupId}
      and state in ('created','retry','active')
    limit 1
  `);
  return rows.length > 0;
}

interface CommandResult {
  accepted: boolean;
  detail?: Record<string, unknown>;
}

/**
 * reverify — re-pend a failed/held admission decision, then enqueue the
 * admission batch through #1752's mechanism. The re-pend is dimension-only:
 * the contract digest is unchanged, so the publish produces admission_updated
 * (generation+1) — a fresh withheld publish event whose delivery enqueues a
 * new deterministic job id. An already-pending group skips the re-pend and
 * re-uses its latest withheld publish event.
 */
async function executeReverify(
  db: Db,
  groupId: string,
  eventId: string,
  idempotencyKey: string,
  now: Date,
): Promise<CommandResult> {
  const outcome = await db.transaction(async (tx) => {
    const { root, lifecycle } = await lockAdmissionGroup(tx, groupId);
    if (!root) throw new ApiError('not_found', `question '${groupId}' not found`, 404);
    if (lifecycle == null || lifecycle.scoring_admission_state !== 'withheld') {
      return { accepted: false, detail: { rejected_reason: 'not_withheld' } };
    }
    if (lifecycle.suspended || lifecycle.withdrawn) {
      return { accepted: false, detail: { rejected_reason: 'suspended_or_withdrawn' } };
    }
    const withheldReason = lifecycle.scoring_admission_withheld_reason;
    if (
      withheldReason === 'unverified_rules' &&
      now.getTime() - lifecycle.updated_at.getTime() < AWAITING_ADMISSION_REVERIFY_AFTER_MS
    ) {
      // Mirrors next_action: inside the wait window there is no reverify button.
      return { accepted: false, detail: { rejected_reason: 'within_wait_window' } };
    }

    let publishEventId: string | null = null;
    let publishStatus: string | null = null;
    if (withheldReason !== 'unverified_rules') {
      // Re-pend: dimension-only publish (same digest ⇒ admission_updated) so the
      // withheld publish event re-enters #1752's enqueue subscription.
      const published = await publishQuestionGroup(tx, {
        group_id: groupId,
        contract: await currentRevisionContract(tx, groupId, lifecycle.current_revision_id),
        expectedCurrentRevision: lifecycle.current_revision_id,
        expectedAdmissionGeneration: lifecycle.scoring_admission_generation,
        availability: lifecycle.availability,
        admission: { state: 'withheld', reason: 'unverified_rules' },
        actorRef: `${ACTOR_REF}:reverify`,
        now,
      });
      if (published.status === 'conflict') {
        throw new ApiError(
          'conflict',
          `question '${groupId}' admission state changed concurrently`,
          409,
        );
      }
      publishStatus = published.status;
      publishEventId = 'event_id' in published ? published.event_id : null;
    } else {
      // Already pending: reuse the latest withheld publish event for the current
      // revision as the enqueue delivery source.
      const [source] = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:assessment_publish'),
            eq(event.subject_kind, 'question'),
            eq(event.subject_id, groupId),
            eq(event.outcome, 'success'),
            sql`${event.actor_ref} <> 'practice:question_admission'`,
            sql`${event.payload}->>'admission' = 'withheld'`,
            sql`${event.payload}->>'revision_id' = ${lifecycle.current_revision_id}`,
          ),
        )
        .orderBy(desc(event.created_at))
        .limit(1);
      publishEventId = source?.id ?? null;
    }

    const control = await readPaidEffectControl(tx, ADMISSION_FAMILY);
    await writeServingActionEvent(tx, {
      eventId,
      groupId,
      command: 'reverify',
      idempotencyKey,
      accepted: true,
      holdReason: withheldReason === 'unverified_rules' ? 'awaiting_admission' : 'admission_failed',
      detail: {
        repended: withheldReason !== 'unverified_rules',
        publish_status: publishStatus,
      },
      now,
    });
    return {
      accepted: true,
      publishEventId,
      publishStatus,
      dispatchGeneration: control.generation,
      revisionId: lifecycle.current_revision_id,
    };
  });
  if (!outcome.accepted) return { accepted: false, detail: outcome.detail };

  // Post-commit: enqueue the admission batch through #1752's own mechanism. The
  // publish event (new or reused) is the delivery source; the subscriber may
  // race us to the same deterministic job id — both paths are idempotent.
  let enqueuedVia: 'publish_event' | 'manual_redispatch' | 'already_queued' | 'none' = 'none';
  if (outcome.publishEventId != null) {
    const enqueue = await enqueuePublishedQuestionAdmission(db, {
      subscriberId: 'practice.serving-actions',
      subscriberVersion: 1,
      deliverySeq: '0',
      sourceEventId: outcome.publishEventId,
    });
    enqueuedVia = enqueue.status === 'succeeded' ? 'publish_event' : 'already_queued';
  }
  if (enqueuedVia !== 'publish_event' && !(await admissionJobInFlight(db, groupId))) {
    // The deterministic job already ran to completion (or the publish-event row
    // is absent) — a manual fresh-id re-dispatch onto the same family queue
    // replays the paid_effect claim under the same locks; identical base never
    // re-pays.
    const boss = await getPracticeBoss();
    const jobData = {
      question_id: groupId,
      ...(outcome.revisionId != null ? { revision_id: outcome.revisionId } : {}),
      dispatch_generation: outcome.dispatchGeneration,
    } satisfies AdmissionJobData;
    await boss.send(ADMISSION_FAMILY, jobData, { id: randomUUID() });
    enqueuedVia = 'manual_redispatch';
  }
  return {
    accepted: true,
    detail: {
      enqueued_via: enqueuedVia,
      ...(outcome.publishStatus != null ? { publish_status: outcome.publishStatus } : {}),
    },
  };
}

/** Current revision's stored contract — verbatim, so the seam's recompute
 * matches its own integrity_digest (the #1753 verify_hold-clear pattern). */
async function currentRevisionContract(tx: Tx, groupId: string, revisionId: string | null) {
  if (revisionId == null) {
    throw new ApiError(
      'conflict',
      `question '${groupId}' has no current revision to carry the dimension update`,
      409,
    );
  }
  const [revision] = await tx
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, revisionId))
    .limit(1);
  if (revision == null) {
    throw new ApiError(
      'conflict',
      `question '${groupId}' current revision '${revisionId}' is missing`,
      409,
    );
  }
  return {
    structure: revision.structure,
    response_spec: revision.response_spec,
    scoring_basis: revision.scoring_basis,
    execution_plan: revision.execution_plan,
    ...(revision.presentation != null ? { presentation: revision.presentation } : {}),
    integrity_digest: revision.integrity_digest,
  };
}

/**
 * recheck_source — re-dispatch source_verify. The outbox intent ledger cannot
 * express a second dispatch for the same (verifier, question), so the command
 * sends straight onto the queue the outbox drains to and records itself in the
 * command event. runSourceVerify's terminal-event guard keeps this a no-cost
 * retry: only error-only prior deliveries actually re-run.
 */
async function executeRecheckSource(
  db: Db,
  groupId: string,
  eventId: string,
  idempotencyKey: string,
  now: Date,
): Promise<CommandResult> {
  const serving = (await readQuestionServing(db, [groupId])).get(groupId);
  if (serving?.hold_reason !== 'source_check_failed') {
    await db.transaction(async (tx) => {
      await writeServingActionEvent(tx, {
        eventId,
        groupId,
        command: 'recheck_source',
        idempotencyKey,
        accepted: false,
        holdReason: serving?.hold_reason ?? null,
        detail: { rejected_reason: 'not_source_check_failed' },
        now,
      });
    });
    return { accepted: false, detail: { rejected_reason: 'not_source_check_failed' } };
  }

  const boss = await getPracticeBoss();
  const jobId = randomUUID();
  await boss.send(SERVING_SOURCE_VERIFY_JOB, { question_ids: [groupId] }, { id: jobId });
  await db.transaction(async (tx) => {
    await writeServingActionEvent(tx, {
      eventId,
      groupId,
      command: 'recheck_source',
      idempotencyKey,
      accepted: true,
      holdReason: 'source_check_failed',
      detail: { job_id: jobId },
      now,
    });
  });
  return { accepted: true, detail: { job_id: jobId } };
}

/**
 * release_verify_hold — synchronous clear through the publisher's
 * dimension-only path (#1753 pattern): the current revision's stored contract
 * is carried verbatim (digest unchanged ⇒ admission_updated, never a new
 * revision) and the admission dimension is echoed from the locked lifecycle.
 * suspension:{suspended:false} resolves to a no-op for any non-verify_hold —
 * retraction_hold can never be cleared here.
 */
async function executeReleaseVerifyHold(
  db: Db,
  groupId: string,
  eventId: string,
  idempotencyKey: string,
  now: Date,
): Promise<CommandResult> {
  return db.transaction(async (tx) => {
    const { root, lifecycle } = await lockAdmissionGroup(tx, groupId);
    if (!root) throw new ApiError('not_found', `question '${groupId}' not found`, 404);
    const holdReason =
      lifecycle?.suspended === true
        ? (lifecycle.suspension_reason ?? 'verify_hold')
        : 'not_suspended';
    if (lifecycle == null || lifecycle.suspension_reason !== 'verify_hold') {
      await writeServingActionEvent(tx, {
        eventId,
        groupId,
        command: 'release_verify_hold',
        idempotencyKey,
        accepted: false,
        holdReason: holdReason === 'not_suspended' ? null : holdReason,
        detail: { rejected_reason: holdReason === 'not_suspended' ? 'not_suspended' : holdReason },
        now,
      });
      return { accepted: false, detail: { rejected_reason: holdReason } };
    }

    const published = await publishQuestionGroup(tx, {
      group_id: groupId,
      contract: await currentRevisionContract(tx, groupId, lifecycle.current_revision_id),
      expectedCurrentRevision: lifecycle.current_revision_id,
      expectedAdmissionGeneration: lifecycle.scoring_admission_generation,
      availability: lifecycle.availability,
      admission:
        lifecycle.scoring_admission_state === 'admitted'
          ? {
              state: 'admitted',
              evidence: lifecycle.scoring_admission_evidence ?? null,
            }
          : {
              state: 'withheld',
              reason: (lifecycle.scoring_admission_withheld_reason ??
                'unverified_rules') as WithheldReason,
            },
      suspension: { suspended: false },
      actorRef: `${ACTOR_REF}:release_verify_hold`,
      now,
    });
    if (published.status === 'conflict') {
      throw new ApiError(
        'conflict',
        `question '${groupId}' admission state changed concurrently`,
        409,
      );
    }
    await writeServingActionEvent(tx, {
      eventId,
      groupId,
      command: 'release_verify_hold',
      idempotencyKey,
      accepted: true,
      holdReason: 'verify_hold',
      detail: { publish_status: published.status },
      now,
    });
    return { accepted: true, detail: { publish_status: published.status } };
  });
}

export interface ServingActionResult {
  accepted: boolean;
  serving: QuestionServing;
}

/**
 * Command entry. Idempotent per Idempotency-Key: the first execution's event
 * records `accepted`; a replay returns it with a freshly derived serving.
 */
export async function runServingAction(
  db: Db,
  input: {
    questionId: string;
    command: ServingActionCommand;
    idempotencyKey: string;
  },
): Promise<ServingActionResult> {
  const [row] = await db
    .select({ id: question.id, parentId: question.parent_question_id })
    .from(question)
    .where(eq(question.id, input.questionId))
    .limit(1);
  if (row == null) {
    throw new ApiError('not_found', `question '${input.questionId}' not found`, 404);
  }
  const groupId = row.parentId ?? row.id;
  const eventId = servingActionEventId(groupId, input.command, input.idempotencyKey);

  const existing = await findServingActionEvent(db, eventId);
  if (existing != null) {
    const replayed = await readQuestionServing(db, [input.questionId]);
    return {
      accepted: existing.accepted,
      serving: replayed.get(input.questionId) ?? {
        servable: false,
        hold_reason: null,
        held_since: null,
        next_action: null,
        pending_action: null,
      },
    };
  }

  const now = new Date();
  const result =
    input.command === 'reverify'
      ? await executeReverify(db, groupId, eventId, input.idempotencyKey, now)
      : input.command === 'recheck_source'
        ? await executeRecheckSource(db, groupId, eventId, input.idempotencyKey, now)
        : await executeReleaseVerifyHold(db, groupId, eventId, input.idempotencyKey, now);

  const servings = await readQuestionServing(db, [input.questionId]);
  return {
    accepted: result.accepted,
    serving: servings.get(input.questionId) ?? {
      servable: false,
      hold_reason: null,
      held_since: null,
      next_action: null,
      pending_action: null,
    },
  };
}
