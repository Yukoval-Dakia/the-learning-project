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
//                         row-publish dimension-only path (#1753 semantics —
//                         admission:'preserve' + suspension:{suspended:false} ⇒
//                         admission_updated, never a new revision; a drifted
//                         group rolls the command back instead of minting).
//                         The seam's suspension resolver never clears
//                         retraction_hold.
//
// Every command writes exactly one experimental:question_serving_action event
// keyed by Idempotency-Key; a replay returns the recorded accepted flag with a
// freshly derived serving projection.

import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { Db, Tx } from '@/db/client';
import { readPaidEffectControl } from '@/db/paid-effect-control';
import {
  event,
  paid_effect,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  AWAITING_ADMISSION_REVERIFY_AFTER_MS,
  type QuestionServing,
  SERVING_ACTION_EVENT_ACTION,
  SERVING_SOURCE_VERIFY_JOB,
  type ServingActionCommand,
  type ServingHoldReason,
  readQuestionServing,
} from '@/kernel/read-models/question-serving';
import {
  ADMISSION_FAMILY,
  type AdmissionJobData,
  enqueuePublishedQuestionAdmission,
  lockAdmissionGroup,
} from './admission/enqueue';
import { getPracticeBoss } from './queue-runtime';
import { publishQuestionGroupFromRow } from './quiz/verify-and-promote';

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

/**
 * Deterministic pg-boss job id (UUID) from a seed. A second `send` with the
 * same id collides on the PK and adds nothing — crash-safe re-send (P1-B).
 */
function deterministicJobId(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  const variant = ((Number.parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

const recheckJobId = (eventId: string) => deterministicJobId(`yuk1514:source_verify:${eventId}`);
const reverifyJobId = (eventId: string) => deterministicJobId(`yuk1514:admission:${eventId}`);

/** pgboss.job row probe — false when the boss schema isn't deployed here. */
async function bossJobExists(db: Db | Tx, id: string): Promise<boolean> {
  const probe = await db.execute<{ reg: string | null }>(
    sql`select to_regclass('pgboss.job') as reg`,
  );
  if (probe[0]?.reg == null) return false;
  const rows = await db.execute<{ id: string }>(
    sql`select id::text as id from pgboss.job where id = ${id}::uuid limit 1`,
  );
  return rows.length > 0;
}

/** Send-or-no-op on a deterministic job id (a duplicate PK = the send landed). */
async function sendJobIdempotent(
  db: Db,
  boss: PgBoss,
  name: string,
  data: object,
  id: string,
): Promise<void> {
  if (await bossJobExists(db, id)) return;
  try {
    await boss.send(name, data, { id });
  } catch (err) {
    // A concurrent send of the same id raced us — the job exists either way.
    if (!(await bossJobExists(db, id))) throw err;
  }
}

interface ServingCommandEventRecord {
  accepted: boolean;
  /** P1-C — a persisted ApiError rejection replays the original status/code. */
  error: { code: string; status: number; message: string } | null;
}

async function findServingActionEvent(
  db: Db | Tx,
  eventId: string,
): Promise<ServingCommandEventRecord | null> {
  const [row] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, eventId))
    .limit(1);
  if (row == null) return null;
  const payload = row.payload as Record<string, unknown> | null;
  const error = payload?.error;
  return {
    accepted: payload?.accepted === true,
    error:
      error != null && typeof error === 'object'
        ? (error as { code: string; status: number; message: string })
        : null,
  };
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
  /**
   * Post-commit side effect (queue send / enqueue). Runs AFTER the command
   * event commits — a crash or failed send here is healed by a same-key
   * replay re-sending the deterministic job id (P1-B).
   */
  afterCommit?: () => Promise<void>;
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
  tx: Tx,
  groupId: string,
  eventId: string,
  idempotencyKey: string,
  now: Date,
): Promise<CommandResult> {
  {
    const { root, lifecycle } = await lockAdmissionGroup(tx, groupId);
    if (!root) throw new ApiError('not_found', `question '${groupId}' not found`, 404);
    const rejected = async (rejectedReason: string, holdReason: ServingHoldReason | null) => {
      // Every command writes an event — a rejection also consumes the key.
      await writeServingActionEvent(tx, {
        eventId,
        groupId,
        command: 'reverify',
        idempotencyKey,
        accepted: false,
        holdReason,
        detail: { rejected_reason: rejectedReason },
        now,
      });
      return { accepted: false, detail: { rejected_reason: rejectedReason } } as const;
    };
    const lifecycleHold: ServingHoldReason | null =
      lifecycle == null || lifecycle.scoring_admission_state !== 'withheld'
        ? lifecycle?.suspended === true
          ? lifecycle.suspension_reason === 'retraction_hold'
            ? 'retraction_hold'
            : 'verify_hold'
          : null
        : lifecycle.suspended
          ? lifecycle.suspension_reason === 'retraction_hold'
            ? 'retraction_hold'
            : 'verify_hold'
          : lifecycle.scoring_admission_withheld_reason === 'verification_failed' ||
              lifecycle.scoring_admission_withheld_reason === 'no_admitted_executor'
            ? 'admission_failed'
            : 'awaiting_admission';
    if (lifecycle == null || lifecycle.scoring_admission_state !== 'withheld') {
      return rejected('not_withheld', lifecycleHold);
    }
    if (lifecycle.suspended || lifecycle.withdrawn) {
      return rejected('suspended_or_withdrawn', lifecycleHold);
    }
    const withheldReason = lifecycle.scoring_admission_withheld_reason;
    if (withheldReason === 'owner_hold') {
      // A deliberate owner withhold is not a verification failure — no
      // reverify exists for it (projection reports hold_reason:null, no
      // button; a direct call still fails closed).
      throw new ApiError(
        'owner_hold',
        `question '${groupId}' is withheld by owner decision, not verification`,
        409,
      );
    }
    // An applied verdict for the CURRENT digest is terminal: the claim never
    // re-pays an identical base, so reverify cannot change it. No generation
    // bump, no job.
    if (lifecycle.current_revision_id != null) {
      const [currentRev] = await tx
        .select({ digest: question_revision.integrity_digest })
        .from(question_revision)
        .where(eq(question_revision.revision_id, lifecycle.current_revision_id))
        .limit(1);
      if (currentRev != null) {
        const applied = await tx
          .select({ entityId: paid_effect.entity_id })
          .from(paid_effect)
          .where(
            and(
              eq(paid_effect.family, ADMISSION_FAMILY),
              eq(paid_effect.entity_id, groupId),
              eq(paid_effect.entity_revision, currentRev.digest),
              eq(paid_effect.unit, 'admission@1'),
              eq(paid_effect.state, 'applied'),
            ),
          )
          .limit(1);
        if (applied.length > 0) {
          throw new ApiError(
            'unchanged_base_already_verified',
            `question '${groupId}' already has an applied admission verdict for the current revision`,
            409,
          );
        }
      }
    }
    if (
      withheldReason === 'unverified_rules' &&
      now.getTime() - lifecycle.updated_at.getTime() < AWAITING_ADMISSION_REVERIFY_AFTER_MS
    ) {
      // Mirrors next_action: inside the wait window there is no reverify button.
      return rejected('within_wait_window', 'awaiting_admission');
    }

    let publishEventId: string | null = null;
    let publishStatus: string | null = null;
    if (withheldReason !== 'unverified_rules') {
      // Re-pend through the row-publish seam: it re-normalizes the group contract
      // canonically (stored JSONB key order cannot reproduce integrity_digest —
      // the seam's own P2 check throws), emits a fresh withheld publish event,
      // and enforces admission_updated vs published honestly.
      const published = await publishQuestionGroupFromRow(tx, {
        rootId: groupId,
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
      if (published.status === 'published' || published.status === 'withdrawn') {
        // Rows drifted past the frozen revision (or every part tombstoned) —
        // re-pending would mint a new revision or withdraw the group under a
        // dimension-only command. Same rollback rule as release_verify_hold.
        throw new ApiError(
          'conflict',
          `cannot reverify '${groupId}': group content changed since the held revision (${published.status}) — edit and republish first`,
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
    const publishEventIdFinal = publishEventId;
    const publishStatusFinal = publishStatus;
    const dispatchGeneration = control.generation;
    const revisionId = lifecycle.current_revision_id;
    return {
      accepted: true,
      detail: {
        repended: withheldReason !== 'unverified_rules',
        publish_status: publishStatusFinal,
      },
      // Post-commit (P1-B): the enqueue runs outside the command tx. The job id
      // is deterministic from the command event id — a crash between commit and
      // send, or a failed send, is healed by any same-key replay re-sending the
      // same job id (a PK-collision re-send adds nothing).
      afterCommit: () =>
        dispatchReverifyAdmission(db, {
          groupId,
          eventId,
          publishEventId: publishEventIdFinal,
          dispatchGeneration,
          revisionId,
        }),
    };
  }
}

/**
 * The post-commit admission dispatch, shared by the accepted path and the
 * replay-heal path. #1752's enqueue from the publish event is preferred; the
 * deterministic manual re-dispatch only fires when that path cannot queue.
 */
async function dispatchReverifyAdmission(
  db: Db,
  args: {
    groupId: string;
    eventId: string;
    publishEventId: string | null;
    dispatchGeneration: number;
    revisionId: string | null;
  },
): Promise<void> {
  let enqueuedVia: 'publish_event' | 'manual_redispatch' | 'already_queued' | 'none' = 'none';
  if (args.publishEventId != null) {
    const enqueue = await enqueuePublishedQuestionAdmission(db, {
      subscriberId: 'practice.serving-actions',
      subscriberVersion: 1,
      deliverySeq: '0',
      sourceEventId: args.publishEventId,
    });
    enqueuedVia = enqueue.status === 'succeeded' ? 'publish_event' : 'already_queued';
  }
  if (enqueuedVia !== 'publish_event' && !(await admissionJobInFlight(db, args.groupId))) {
    // The deterministic job already ran to completion (or the publish-event row
    // is absent) — a manual re-dispatch onto the same family queue replays the
    // paid_effect claim under the same locks; identical base never re-pays.
    const boss = await getPracticeBoss();
    const jobData = {
      question_id: args.groupId,
      ...(args.revisionId != null ? { revision_id: args.revisionId } : {}),
      dispatch_generation: args.dispatchGeneration,
    } satisfies AdmissionJobData;
    await sendJobIdempotent(db, boss, ADMISSION_FAMILY, jobData, reverifyJobId(args.eventId));
    enqueuedVia = 'manual_redispatch';
  }
}

/**
 * recheck_source — re-dispatch source_verify. The outbox intent ledger cannot
 * express a second dispatch for the same (verifier, question), so the command
 * sends straight onto the queue the outbox drains to. The command event is
 * written BEFORE the job and the job id is deterministic from it (P1-B):
 * runSourceVerify's terminal-event guard bypasses ONLY for this command, its
 * paid-effect claim (keyed by command_event_id) admits at most one paid
 * attempt, and a same-key replay re-sends this exact job id when it is absent.
 */
async function executeRecheckSource(
  db: Db,
  tx: Tx,
  groupId: string,
  eventId: string,
  idempotencyKey: string,
  now: Date,
): Promise<CommandResult> {
  const serving = (await readQuestionServing(tx, [groupId])).byId.get(groupId);
  if (serving?.hold_reason !== 'source_check_failed') {
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
    return { accepted: false, detail: { rejected_reason: 'not_source_check_failed' } };
  }

  const jobId = recheckJobId(eventId);
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
  return {
    accepted: true,
    detail: { job_id: jobId },
    afterCommit: async () => {
      const boss = await getPracticeBoss();
      await sendJobIdempotent(
        db,
        boss,
        SERVING_SOURCE_VERIFY_JOB,
        { question_ids: [groupId], recheck: { command_event_id: eventId } },
        jobId,
      );
    },
  };
}

/**
 * release_verify_hold — synchronous clear through the publisher's
 * dimension-only path (#1753 semantics): admission:'preserve' keeps the
 * current dimension verbatim, suspension:{suspended:false} clears only
 * verify_hold (the seam's suspension resolver can never touch
 * retraction_hold). The row-publish seam re-normalizes canonically, so an
 * unchanged group is admission_updated with no new revision; a group whose
 * working-copy rows drifted past the frozen revision would MINT one — the
 * contract forbids minting here, so the whole command rolls back on that
 * status instead of silently re-publishing changed content.
 */
async function executeReleaseVerifyHold(
  _db: Db,
  tx: Tx,
  groupId: string,
  eventId: string,
  idempotencyKey: string,
  now: Date,
): Promise<CommandResult> {
  {
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

    const published = await publishQuestionGroupFromRow(tx, {
      rootId: groupId,
      // 'preserve' = keep the current admission dimension verbatim; only the
      // suspension dimension is changing. No verification row is appended —
      // releasing a hold is an owner action, not a verify pass.
      admission: { state: 'preserve' },
      suspension: { suspended: false },
      actorRef: `${ACTOR_REF}:release_verify_hold`,
      now,
    });
    if (published.status === 'published' || published.status === 'withdrawn') {
      // Content drifted past the frozen revision (or every part tombstoned) —
      // continuing would mint a new revision / withdraw the group under what
      // was supposed to be a dimension-only hold release. Roll back the whole
      // command; the owner can reverify instead.
      throw new ApiError(
        'conflict',
        `cannot release verify_hold on '${groupId}': group content changed since the held revision (${published.status}) — reverify it instead`,
        409,
      );
    }
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
  }
}

export interface ServingActionResult {
  accepted: boolean;
  serving: QuestionServing;
}

const UNKNOWN_SERVING: QuestionServing = {
  servable: false,
  hold_reason: null,
  held_since: null,
  next_action: null,
  pending_action: null,
};

/**
 * Replay heal (P1-B): an accepted command's send lives outside its tx, so a
 * crash between the commit and the send would lose the job forever. A same-key
 * replay re-sends the deterministic job id when the job row is absent; for
 * reverify it only heals a group still in a pending cycle (an applied verdict
 * or a moved-on lifecycle means the run already happened).
 */
async function ensureCommandDispatched(
  db: Db,
  groupId: string,
  command: ServingActionCommand,
  eventId: string,
): Promise<void> {
  try {
    if (command === 'recheck_source') {
      const jobId = recheckJobId(eventId);
      if (await bossJobExists(db, jobId)) return;
      const boss = await getPracticeBoss();
      await sendJobIdempotent(
        db,
        boss,
        SERVING_SOURCE_VERIFY_JOB,
        { question_ids: [groupId], recheck: { command_event_id: eventId } },
        jobId,
      );
      return;
    }
    if (command === 'reverify') {
      const { byId } = await readQuestionServing(db, [groupId]);
      const serving = byId.get(groupId);
      if (serving == null || serving.pending_action != null) return;
      if (serving.hold_reason !== 'awaiting_admission') return;
      const [lc] = await db
        .select({ revision: question_group_lifecycle.current_revision_id })
        .from(question_group_lifecycle)
        .where(eq(question_group_lifecycle.group_id, groupId))
        .limit(1);
      const [source] = await db
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
            sql`${event.payload}->>'revision_id' = ${lc?.revision ?? ''}`,
          ),
        )
        .orderBy(desc(event.created_at))
        .limit(1);
      const control = await readPaidEffectControl(db, ADMISSION_FAMILY);
      await dispatchReverifyAdmission(db, {
        groupId,
        eventId,
        publishEventId: source?.id ?? null,
        dispatchGeneration: control.generation,
        revisionId: lc?.revision ?? null,
      });
    }
  } catch (err) {
    // Heal is best-effort — a failure here is surfaced by the still-present
    // hold, and the next replay retries.
    console.error('[serving-actions] replay dispatch heal failed', command, eventId, err);
  }
}

/**
 * Command entry. Idempotent per Idempotency-Key under an advisory lock keyed
 * by the deterministic event id: a concurrent same-key POST waits for the
 * winner's commit and replays — it never sends a second job (P1-A). ApiError
 * rejections are persisted in their own tx (P1-C) so any replay of the key
 * returns the original status and code forever.
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
  const now = new Date();

  let dispatched:
    | { kind: 'replay'; existing: ServingCommandEventRecord }
    | { kind: 'executed'; outcome: CommandResult };
  try {
    dispatched = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`yuk1514:serving:${eventId}`}, 0))`,
      );
      const existing = await findServingActionEvent(tx, eventId);
      if (existing != null) return { kind: 'replay' as const, existing };

      // P2-1 — an Idempotency-Key is scoped to (question group × command):
      // reusing the same key on a different command or a different group is a
      // protocol error, not a fresh command.
      const reuseRows = await tx
        .select({ subjectId: event.subject_id, payload: event.payload })
        .from(event)
        .where(
          and(
            eq(event.action, SERVING_ACTION_EVENT_ACTION),
            sql`${event.payload}->>'idempotency_key' = ${input.idempotencyKey}`,
          ),
        );
      for (const reuse of reuseRows) {
        const reusedCommand =
          reuse.payload != null && typeof reuse.payload === 'object'
            ? (reuse.payload as Record<string, unknown>).command
            : null;
        if (reuse.subjectId !== groupId || reusedCommand !== input.command) {
          throw new ApiError(
            'idempotency_key_reused',
            `Idempotency-Key '${input.idempotencyKey}' was already used for a different question or command`,
            409,
          );
        }
      }

      const outcome =
        input.command === 'reverify'
          ? await executeReverify(db, tx, groupId, eventId, input.idempotencyKey, now)
          : input.command === 'recheck_source'
            ? await executeRecheckSource(db, tx, groupId, eventId, input.idempotencyKey, now)
            : await executeReleaseVerifyHold(db, tx, groupId, eventId, input.idempotencyKey, now);
      return { kind: 'executed' as const, outcome };
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // P1-C — the mutation tx rolled back; record the rejection outcome in its
      // own tx so a later replay of this key returns the ORIGINAL 409 rather
      // than re-executing against changed state.
      await db.transaction(async (tx) =>
        writeServingActionEvent(tx, {
          eventId,
          groupId,
          command: input.command,
          idempotencyKey: input.idempotencyKey,
          accepted: false,
          holdReason: null,
          detail: { error: { code: err.code, status: err.status, message: err.message } },
          now,
        }),
      );
    }
    throw err;
  }

  if (dispatched.kind === 'replay') {
    const { existing } = dispatched;
    if (existing.error != null) {
      throw new ApiError(existing.error.code, existing.error.message, existing.error.status);
    }
    if (existing.accepted) {
      await ensureCommandDispatched(db, groupId, input.command, eventId);
    }
    const replayed = await readQuestionServing(db, [input.questionId]);
    return {
      accepted: existing.accepted,
      serving: replayed.byId.get(input.questionId) ?? UNKNOWN_SERVING,
    };
  }

  const { outcome } = dispatched;
  if (outcome.afterCommit != null) {
    try {
      await outcome.afterCommit();
    } catch (err) {
      // The command event committed — a failed send is healed by any same-key
      // replay (deterministic job id, P1-B). Report the recorded outcome; the
      // hold remains visible until healed.
      console.error('[serving-actions] post-commit dispatch failed', input.command, eventId, err);
    }
  }
  const servings = await readQuestionServing(db, [input.questionId]);
  return {
    accepted: outcome.accepted,
    serving: servings.byId.get(input.questionId) ?? UNKNOWN_SERVING,
  };
}
