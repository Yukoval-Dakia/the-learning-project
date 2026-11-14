import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { type AnyColumn, and, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import type { WriteEventInput } from '@/kernel/events/index';
import { writeEvent, writeEvents } from '@/kernel/events/index';
import { declaredAdmissionOwned } from '@/kernel/read-models/question-admission-ownership';
import type { PlacementVerificationAuthority } from '@/kernel/supply-contracts';

export const VERIFY_DISPATCH_INTENT_ACTION = 'experimental:verify_dispatch_intent';
// Bound marks the committed obligation between intent write and engine send: the
// drain binds intents to a stable delivery id inside one transaction, sends after
// commit, and only then writes the completion ack.
export const VERIFY_DISPATCH_BOUND_ACTION = 'experimental:verify_dispatch_bound';
export const VERIFY_DISPATCH_COMPLETE_ACTION = 'experimental:verify_dispatch';
export const VERIFY_DISPATCH_VERSION = 1 as const;

// Leave a daily recovery gap after errors; queue liveness separately covers delayed retries.
const SOURCE_VERIFY_RECOVERY_MIN_AGE_MS = 20 * 60 * 60_000;
const SOURCE_VERIFY_RECOVERY_BATCH_SIZE = 50;

function noLiveSourceVerifyJob(questionId: AnyColumn) {
  return sql`NOT EXISTS (
    SELECT 1 FROM pgboss.job j
    WHERE j.name = 'source_verify' AND j.state IN ('created', 'retry', 'active')
      AND j.data->'question_ids' @> jsonb_build_array(${questionId})
  )`;
}

function eligibleRecoveryError(questionId: AnyColumn, now: Date, epoch?: AnyColumn) {
  return sql`EXISTS (
    SELECT 1 FROM ${event} e
    WHERE e.subject_kind = 'question' AND e.subject_id = ${questionId} AND e.action = 'experimental:source_verify'
      AND e.outcome = 'error' AND e.payload->'recovery_eligible' = 'true'::jsonb
      AND e.created_at <= ${new Date(now.getTime() - SOURCE_VERIFY_RECOVERY_MIN_AGE_MS).toISOString()}
      ${epoch ? sql`AND e.id = ${epoch}->>'recovery_epoch'` : sql``}
      AND NOT EXISTS (SELECT 1 FROM ${event} n
        WHERE n.subject_kind = e.subject_kind AND n.subject_id = e.subject_id AND n.action = e.action
          AND (n.created_at, n.dispatch_seq, n.id) > (e.created_at, e.dispatch_seq, e.id))
  )`;
}

function noRecentRecoveryIntent(questionId: AnyColumn, now: Date) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${event} i
    WHERE i.subject_kind = 'question' AND i.subject_id = ${questionId} AND i.action = ${VERIFY_DISPATCH_INTENT_ACTION}
      AND i.payload->>'verifier_kind' = 'source_verify'
      AND i.payload->>'recovery_epoch' IS NOT NULL
      AND i.created_at > ${new Date(now.getTime() - SOURCE_VERIFY_RECOVERY_MIN_AGE_MS).toISOString()}
  )`;
}

export const verifyKindSchema = z.enum(['quiz_verify', 'source_verify']);
export type VerifyKind = z.infer<typeof verifyKindSchema>;

const verifyDispatchIntentPayloadSchema = z.object({
  version: z.literal(VERIFY_DISPATCH_VERSION),
  verifier_kind: verifyKindSchema,
  question_id: z.string().min(1),
  supply_trace: z.record(z.string(), z.unknown()).optional(),
  placement_authority: z
    .object({
      claim_id: z.string().min(1),
      attempt_id: z.string().min(1),
      question_id: z.string().min(1),
      verification_authority_epoch: z.string().uuid(),
      fencing_token: z.string().uuid(),
    })
    .optional(),
  /** Sweep recovery only: the source_verify error event this intent re-drives. */
  recovery_epoch: z.string().min(1).optional(),
  recovery_attempt: z.number().int().positive().optional(),
  /** Copied from the recovered error event so the run consults that command's
   * paid-effect claim instead of re-paying under it. */
  recheck_command_event_id: z.string().min(1).optional(),
});

type VerifyDispatchIntentPayload = z.infer<typeof verifyDispatchIntentPayloadSchema>;

const verifyDispatchBoundPayloadSchema = z.object({
  version: z.literal(VERIFY_DISPATCH_VERSION),
  verifier_kind: verifyKindSchema,
  /** Stable engine delivery identity, derived from the member intent ids. */
  delivery_id: z.string().min(1),
  question_ids: z.array(z.string().min(1)).min(1),
  intent_ids: z.array(z.string().min(1)).min(1),
});

type VerifyDispatchBoundPayload = z.infer<typeof verifyDispatchBoundPayloadSchema>;

/** Server-written recovery marker for one question in a sweep-created job. Only
 * an intent carrying recovery_epoch produces this; job redelivery or client
 * input cannot mint it, so it is the sole authority for the recovery path. */
export interface VerifyRecoveryMark {
  epoch: string;
  recheck_command_event_id?: string;
}

export type EnqueueVerifyFn = (
  verifier: VerifyKind,
  questionIds: string[],
  options?: object,
  placementAuthorities?: PlacementVerificationAuthority[],
  recoveryMarks?: Record<string, VerifyRecoveryMark>,
) => Promise<void>;

export interface VerifyDispatchResult {
  synthesized: number;
  dispatched: number;
  skippedTerminal: number;
  failed: number;
}

// The id includes the schema version. writeEvent is insert-only, so a colliding id would
// no-op the replacement and leave the draft stuck. The id stays deterministic per version.
// A corrupt current-version payload can occupy that id only if someone hand-builds the digest.
// Append-only writes do not do that.
const VERIFY_DISPATCH_VERSION_TAG = String(VERIFY_DISPATCH_VERSION);

// Cheap probe for a current-version intent. An incomplete row must not count as dispatchable.
// Dispatch would drop it without a completion and keep locking that page. Synthesis would
// treat it as already owned. safeParse still rejects what this probe cannot see.
function isStructurallyDispatchableIntent(payload: AnyColumn) {
  return and(
    sql`${payload}->>'version' = ${VERIFY_DISPATCH_VERSION_TAG}`,
    sql`${payload}->>'verifier_kind' IN (${sql.join(
      verifyKindSchema.options.map((kind) => sql`${kind}`),
      sql`, `,
    )})`,
    sql`${payload}->>'question_id' IS NOT NULL`,
    sql`${payload}->>'question_id' <> ''`,
  );
}

function placementAuthorityIdentity(authority?: PlacementVerificationAuthority): string {
  return authority
    ? `\0${authority.claim_id}\0${authority.attempt_id}\0${authority.verification_authority_epoch}`
    : '';
}

// JSONB does not keep key order, so stringify can report a false conflict. Compare the fields.
function placementAuthorityEquals(
  a: PlacementVerificationAuthority | undefined,
  b: PlacementVerificationAuthority | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.claim_id === b.claim_id &&
    a.attempt_id === b.attempt_id &&
    a.question_id === b.question_id &&
    a.verification_authority_epoch === b.verification_authority_epoch &&
    a.fencing_token === b.fencing_token
  );
}

function stableEventId(
  kind: 'intent' | 'bound' | 'complete',
  questionId: string,
  verifier: VerifyKind,
  authority?: PlacementVerificationAuthority,
  recoveryEpoch?: string,
  recoveryAttempt?: number,
) {
  const digest = createHash('sha256')
    .update(
      `${verifier}\0${questionId}${placementAuthorityIdentity(authority)}` +
        (recoveryEpoch != null ? `\0${recoveryEpoch}` : '') +
        (recoveryAttempt != null ? `\0${recoveryAttempt}` : ''),
    )
    .digest('hex');
  return `verify-dispatch-${kind}-v${VERIFY_DISPATCH_VERSION_TAG}-${digest}`;
}

function intentEventId(
  questionId: string,
  verifier: VerifyKind,
  authority?: PlacementVerificationAuthority,
  recoveryEpoch?: string,
  recoveryAttempt?: number,
) {
  return stableEventId('intent', questionId, verifier, authority, recoveryEpoch, recoveryAttempt);
}

function completeEventId(
  questionId: string,
  verifier: VerifyKind,
  authority?: PlacementVerificationAuthority,
  recoveryEpoch?: string,
  recoveryAttempt?: number,
) {
  return stableEventId('complete', questionId, verifier, authority, recoveryEpoch, recoveryAttempt);
}

// Bound ids mirror intent ids so the redrive join needs no payload lookup: swap
// the kind segment and the digest stays identical.
export function verifyDispatchBoundEventIdForIntent(intentId: string) {
  return intentId.replace('verify-dispatch-intent-', 'verify-dispatch-bound-');
}

// The engine delivery id is content-derived from the member intents, so a crash
// after bind and any concurrent drain re-drive the identical job.
export function verifyDeliveryJobId(verifier: VerifyKind, memberIntentIds: string[]) {
  const digest = createHash('sha256')
    .update(`verify-dispatch-delivery-v${VERIFY_DISPATCH_VERSION_TAG}\0${verifier}`)
    .update(`\0${[...memberIntentIds].sort().join('\0')}`)
    .digest('hex');
  // RFC 9562 uuidv8: sha256 application bits with version/variant stamped.
  const bytes = digest.slice(0, 32).split('');
  bytes[12] = '8';
  bytes[16] = ((Number.parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16);
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Tombstoned drafts (archived or owner-dismissed) are dead, not pending —
 * never synthesize/dispatch a paid verify against them (mirrors the
 * verifyAndPromote guard). */
function metadataIsArchived(metadata: unknown): boolean {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    ((metadata as Record<string, unknown>).archived_at != null ||
      (metadata as Record<string, unknown>).dismissed_at != null)
  );
}

function isTerminalVerifyEvent(row: { action: string; outcome: string | null }): boolean {
  return (
    (row.action === 'experimental:quiz_verify' || row.action === 'experimental:source_verify') &&
    row.outcome !== 'error'
  );
}

export async function writeVerifyDispatchIntent(
  db: Db | Tx,
  input: {
    questionId: string;
    verifier: VerifyKind;
    supplyTrace?: unknown;
    placementAuthority?: PlacementVerificationAuthority;
    recoveryEpoch?: string;
    /** Ordinal under the question lock lets the same error recover after a lost delivery. */
    recoveryAttempt?: number;
    recheckCommandEventId?: string;
    createdAt?: Date;
  },
): Promise<string> {
  const payload: VerifyDispatchIntentPayload = verifyDispatchIntentPayloadSchema.parse({
    version: VERIFY_DISPATCH_VERSION,
    verifier_kind: input.verifier,
    question_id: input.questionId,
    ...(input.supplyTrace ? { supply_trace: input.supplyTrace } : {}),
    ...(input.placementAuthority ? { placement_authority: input.placementAuthority } : {}),
    ...(input.recoveryEpoch != null ? { recovery_epoch: input.recoveryEpoch } : {}),
    ...(input.recoveryAttempt != null ? { recovery_attempt: input.recoveryAttempt } : {}),
    ...(input.recheckCommandEventId != null
      ? { recheck_command_event_id: input.recheckCommandEventId }
      : {}),
  });
  const id = intentEventId(
    input.questionId,
    input.verifier,
    input.placementAuthority,
    input.recoveryEpoch,
    input.recoveryAttempt,
  );
  if (input.placementAuthority) {
    const [existing] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.id, id))
      .limit(1);
    if (existing) {
      const parsed = verifyDispatchIntentPayloadSchema.safeParse(existing.payload);
      if (
        !parsed.success ||
        !placementAuthorityEquals(parsed.data.placement_authority, input.placementAuthority)
      ) {
        throw new Error('verify dispatch intent placement authority conflict');
      }
      return id;
    }
  }
  return writeEvent(db, {
    id,
    actor_kind: 'system',
    actor_ref: 'verify_dispatch_outbox',
    action: VERIFY_DISPATCH_INTENT_ACTION,
    subject_kind: 'question',
    subject_id: input.questionId,
    outcome: null,
    payload,
    created_at: input.createdAt,
    ingest_at: input.createdAt ?? new Date(),
  });
}

function dispatchCompletionEvent(
  intent: VerifyDispatchIntentPayload,
  input: {
    recovery: boolean;
    disposition: 'enqueued' | 'terminal_skip';
    deliveryId?: string;
    now: Date;
  },
): WriteEventInput {
  return {
    id: completeEventId(
      intent.question_id,
      intent.verifier_kind,
      intent.placement_authority,
      intent.recovery_epoch,
      intent.recovery_attempt,
    ),
    actor_kind: 'system',
    actor_ref: 'verify_dispatch_outbox',
    action: VERIFY_DISPATCH_COMPLETE_ACTION,
    subject_kind: 'question',
    subject_id: intent.question_id,
    outcome: 'success',
    payload: {
      version: VERIFY_DISPATCH_VERSION,
      verifier_kind: intent.verifier_kind,
      question_id: intent.question_id,
      stage: 'verify_enqueue',
      recovery: input.recovery,
      disposition: input.disposition,
      ...(input.deliveryId != null ? { delivery_id: input.deliveryId } : {}),
      ...(intent.supply_trace ? { supply_trace: intent.supply_trace } : {}),
      ...(intent.placement_authority ? { placement_authority: intent.placement_authority } : {}),
      ...(intent.recovery_epoch != null ? { recovery_epoch: intent.recovery_epoch } : {}),
      ...(intent.recovery_attempt != null ? { recovery_attempt: intent.recovery_attempt } : {}),
      ...(intent.recheck_command_event_id != null
        ? { recheck_command_event_id: intent.recheck_command_event_id }
        : {}),
    },
    created_at: input.now,
    ingest_at: input.now,
  };
}

async function writeDispatchFailure(
  db: Db,
  input: { recovery: boolean; questionIds?: string[]; error: unknown },
) {
  try {
    const now = new Date();
    // The event log is append-only and widely read. Driver errors can carry hosts and query text.
    const rawMsg = input.error instanceof Error ? input.error.message : String(input.error);
    await writeEvent(db, {
      id: createId(),
      actor_kind: 'system',
      actor_ref: 'verify_dispatch_outbox',
      action: VERIFY_DISPATCH_COMPLETE_ACTION,
      subject_kind: 'query',
      subject_id: 'verify_dispatch_outbox',
      outcome: 'failure',
      payload: {
        version: VERIFY_DISPATCH_VERSION,
        stage: 'verify_enqueue',
        recovery: input.recovery,
        question_ids: input.questionIds ?? [],
        error: rawMsg.slice(0, 500),
      },
      created_at: now,
      ingest_at: now,
    });
  } catch (error) {
    console.error('[verify-dispatch-outbox] failed to persist enqueue failure metric:', error);
  }
}

interface BoundVerifyDelivery {
  deliveryId: string;
  verifier: VerifyKind;
  questionIds: string[];
  intents: VerifyDispatchIntentPayload[];
  /** Recovery deliveries keep retryLimit 0: the epoch claim, not pgboss retries,
   * owns a paid recovery. */
  recovery: boolean;
}

// The pending claim for a drain pass. Bind adds `¬bound`: the bound row itself
// is the durable ownership claim, so a bound-but-unacked intent belongs to its
// recorded delivery and no other drain may sweep it into a second batch.
function pendingIntentPredicates(
  tx: Db | Tx,
  input: {
    recoveryOnly?: boolean;
    /** Bind only: only intents minted by this sweep may bind in this pass. */
    freshOnly?: boolean;
    questionIds?: string[];
    now: Date;
  },
) {
  const completion = alias(event, 'verify_dispatch_completion');
  const boundProbe = alias(event, 'verify_dispatch_bound_probe');
  return [
    eq(event.action, VERIFY_DISPATCH_INTENT_ACTION),
    eq(event.subject_kind, 'question'),
    input.recoveryOnly
      ? and(
          sql`${event.payload}->>'recovery_epoch' IS NOT NULL`,
          ...(input.freshOnly ? [sql`${event.created_at} = ${input.now.toISOString()}`] : []),
          sql`NOT EXISTS (SELECT 1 FROM ${event} i
            WHERE i.subject_kind = ${event.subject_kind} AND i.subject_id = ${event.subject_id} AND i.action = ${VERIFY_DISPATCH_INTENT_ACTION}
              AND i.payload->>'verifier_kind' = 'source_verify'
              AND i.payload->>'recovery_epoch' IS NOT NULL
              AND (i.created_at, i.id) > (${event.created_at}, ${event.id}))`,
          eligibleRecoveryError(event.subject_id, input.now, event.payload),
          noLiveSourceVerifyJob(event.subject_id),
        )
      : and(
          sql`${event.payload}->>'recovery_epoch' IS NULL`,
          sql`NOT EXISTS (SELECT 1 FROM ${event} v
            WHERE v.subject_id = ${event.subject_id}
              AND v.action = 'experimental:source_verify' AND v.outcome = 'error')`,
        ),
    // An incomplete or wrong-version intent never gets a completion, so it would keep the oldest lock page.
    isStructurallyDispatchableIntent(event.payload),
    // Filter completions before LIMIT. Otherwise every drain locks the same finished page.
    notExists(
      tx
        .select({ id: completion.id })
        .from(completion)
        .where(
          and(
            eq(completion.action, VERIFY_DISPATCH_COMPLETE_ACTION),
            eq(completion.subject_id, event.subject_id),
            sql`${completion.payload}->>'verifier_kind' = ${event.payload}->>'verifier_kind'`,
            sql`COALESCE(${completion.payload}->'placement_authority', 'null'::jsonb) = COALESCE(${event.payload}->'placement_authority', 'null'::jsonb)`,
            sql`COALESCE(${completion.payload}->>'recovery_epoch', '') = COALESCE(${event.payload}->>'recovery_epoch', '')`,
            sql`COALESCE(${completion.payload}->>'recovery_attempt', '') = COALESCE(${event.payload}->>'recovery_attempt', '')`,
          ),
        ),
    ),
    ...(input.freshOnly
      ? [
          notExists(
            tx
              .select({ id: boundProbe.id })
              .from(boundProbe)
              .where(
                and(
                  eq(boundProbe.action, VERIFY_DISPATCH_BOUND_ACTION),
                  sql`${boundProbe.id} = replace(${event.id}, 'verify-dispatch-intent-', 'verify-dispatch-bound-')`,
                ),
              ),
          ),
        ]
      : []),
    ...(input.questionIds ? [inArray(event.subject_id, input.questionIds)] : []),
  ];
}

// Bound ∧ unacked member intents, grouped by the delivery recorded at bind.
// The send reuses the bound member set verbatim, so a redrive presents the
// engine with the identical delivery.
async function selectBoundDeliveries(
  db: Db,
  input: {
    recoveryOnly?: boolean;
    questionIds?: string[];
    batchSize?: number;
    now: Date;
  },
): Promise<BoundVerifyDelivery[]> {
  const bound = alias(event, 'verify_dispatch_bound');
  const rows = await db
    .select({ intentPayload: event.payload, boundPayload: bound.payload })
    .from(event)
    .innerJoin(
      bound,
      sql`${bound.id} = replace(${event.id}, 'verify-dispatch-intent-', 'verify-dispatch-bound-')`,
    )
    .where(and(...pendingIntentPredicates(db, { ...input, freshOnly: false })))
    .limit(input.batchSize ?? 100);

  const byDelivery = new Map<
    string,
    { bound: VerifyDispatchBoundPayload; intents: VerifyDispatchIntentPayload[] }
  >();
  for (const row of rows) {
    const boundParsed = verifyDispatchBoundPayloadSchema.safeParse(row.boundPayload);
    const intentParsed = verifyDispatchIntentPayloadSchema.safeParse(row.intentPayload);
    if (!boundParsed.success || !intentParsed.success) continue;
    const bucket = byDelivery.get(boundParsed.data.delivery_id) ?? {
      bound: boundParsed.data,
      intents: [],
    };
    bucket.intents.push(intentParsed.data);
    byDelivery.set(boundParsed.data.delivery_id, bucket);
  }
  return [...byDelivery.values()].map(({ bound: boundPayload, intents }) => ({
    deliveryId: boundPayload.delivery_id,
    verifier: boundPayload.verifier_kind,
    questionIds: boundPayload.question_ids,
    intents,
    recovery: intents.some((intent) => intent.recovery_epoch != null),
  }));
}

async function enqueueBoundDelivery(
  enqueue: EnqueueVerifyFn,
  delivery: BoundVerifyDelivery,
): Promise<void> {
  const byQuestion = new Map(delivery.intents.map((intent) => [intent.question_id, intent]));
  const placementAuthorities = delivery.questionIds.flatMap((questionId) => {
    const authority = byQuestion.get(questionId)?.placement_authority;
    return authority ? [authority] : [];
  });
  const recoveryMarks: Record<string, VerifyRecoveryMark> = {};
  for (const intent of delivery.intents) {
    if (intent.recovery_epoch != null) {
      recoveryMarks[intent.question_id] = {
        epoch: intent.recovery_epoch,
        ...(intent.recheck_command_event_id != null
          ? { recheck_command_event_id: intent.recheck_command_event_id }
          : {}),
      };
    }
  }
  await enqueue(
    delivery.verifier,
    delivery.questionIds,
    {
      id: delivery.deliveryId,
      ...(delivery.recovery ? { retryLimit: 0 } : {}),
    },
    placementAuthorities.length > 0 ? placementAuthorities : undefined,
    Object.keys(recoveryMarks).length > 0 ? recoveryMarks : undefined,
  );
}

export async function dispatchPendingVerifyIntents(
  db: Db,
  input: {
    enqueue: EnqueueVerifyFn;
    questionIds?: string[];
    recovery?: boolean;
    recoveryOnly?: boolean;
    batchSize?: number;
    now?: Date;
  },
): Promise<VerifyDispatchResult> {
  const empty: VerifyDispatchResult = {
    synthesized: 0,
    dispatched: 0,
    skippedTerminal: 0,
    failed: 0,
  };
  if (input.questionIds?.length === 0) return empty;
  const recovery = input.recovery ?? false;
  const now = input.now ?? new Date();
  // The catch runs after rollback, and a full scan has no questionIds length to report.
  let lockedCount = 0;
  try {
    // Phase 1 — bind: classify the locked page and commit durable delivery
    // claims. No engine call happens here, so a crash leaves only bound rows
    // that the redrive below re-drives under the same stable delivery id.
    const bound = await db.transaction(async (tx) => {
      const predicates = pendingIntentPredicates(tx, {
        recoveryOnly: input.recoveryOnly,
        freshOnly: true,
        questionIds: input.questionIds,
        now,
      });
      const locked = await tx
        .select({ id: event.id, subjectId: event.subject_id, payload: event.payload })
        .from(event)
        .where(and(...predicates))
        .orderBy(
          input.recoveryOnly
            ? sql`(SELECT e.created_at FROM ${event} e WHERE e.id = ${event.payload}->>'recovery_epoch')`
            : event.created_at,
          event.id,
        )
        .limit(input.batchSize ?? 100)
        .for('update', { skipLocked: true });
      lockedCount = locked.length;
      if (locked.length === 0) return { skippedTerminal: 0 };

      // One corrupt payload must not abort the locked page. Skip it. The SQL probe is not the full schema.
      const intents = locked
        .map((row) => verifyDispatchIntentPayloadSchema.safeParse(row.payload))
        .filter((result) => result.success)
        .map((result) => result.data);
      if (input.questionIds) {
        const requestedOrder = new Map(input.questionIds.map((id, index) => [id, index]));
        intents.sort(
          (a, b) =>
            (requestedOrder.get(a.question_id) ?? Number.MAX_SAFE_INTEGER) -
            (requestedOrder.get(b.question_id) ?? Number.MAX_SAFE_INTEGER),
        );
      }
      const pending = intents;

      const questionIds = [...new Set(pending.map((intent) => intent.question_id))];
      const questionRows = await tx
        .select({
          id: question.id,
          draftStatus: question.draft_status,
          admissionOwned: declaredAdmissionOwned(),
          metadata: question.metadata,
          parentQuestionId: question.parent_question_id,
        })
        .from(question)
        .where(inArray(question.id, questionIds));
      const questions = new Map(questionRows.map((row) => [row.id, row]));
      const verifyRows = await tx
        .select({
          id: event.id,
          subjectId: event.subject_id,
          action: event.action,
          outcome: event.outcome,
          createdAt: event.created_at,
        })
        .from(event)
        .where(
          and(
            inArray(event.subject_id, questionIds),
            inArray(event.action, ['experimental:quiz_verify', 'experimental:source_verify']),
          ),
        );
      const verifyByQuestion = new Map<string, typeof verifyRows>();
      for (const row of verifyRows) {
        const bucket = verifyByQuestion.get(row.subjectId);
        if (bucket) bucket.push(row);
        else verifyByQuestion.set(row.subjectId, [row]);
      }
      // A recovery intent is suppressed only by a terminal event NEWER than the
      // epoch error it re-drives: an older terminal followed by the epoch error
      // is exactly what recovery exists for. An ordinary intent suppresses on
      // any terminal event. An unresolvable epoch suppresses (fail-closed).
      const terminalHit = (intent: VerifyDispatchIntentPayload): boolean => {
        const rows = verifyByQuestion.get(intent.question_id) ?? [];
        const action =
          intent.verifier_kind === 'source_verify'
            ? 'experimental:source_verify'
            : 'experimental:quiz_verify';
        if (intent.recovery_epoch == null) {
          return rows.some((row) => row.action === action && row.outcome !== 'error');
        }
        const epoch = rows.find((row) => row.id === intent.recovery_epoch);
        if (epoch == null) return true;
        const epochTs = epoch.createdAt.getTime();
        return rows.some(
          (row) =>
            row.action === action &&
            row.outcome !== 'error' &&
            (row.createdAt.getTime() > epochTs ||
              (row.createdAt.getTime() === epochTs && row.id > epoch.id)),
        );
      };

      const terminal: VerifyDispatchIntentPayload[] = [];
      const eligible: VerifyDispatchIntentPayload[] = [];
      for (const intent of pending) {
        const row = questions.get(intent.question_id);
        if (
          row?.draftStatus !== 'draft' ||
          metadataIsArchived(row.metadata) ||
          (intent.verifier_kind === 'quiz_verify' && row.admissionOwned) ||
          // A part has no verify of its own. The parent's cascade owns it. Drain a stray intent instead of enqueueing a job that can only skip.
          row.parentQuestionId != null ||
          terminalHit(intent)
        ) {
          terminal.push(intent);
        } else {
          eligible.push(intent);
        }
      }

      const written: WriteEventInput[] = [];
      for (const verifier of verifyKindSchema.options) {
        const group = eligible.filter((intent) => intent.verifier_kind === verifier);
        if (group.length === 0) continue;
        // Isolate recovery failures; the handler stops a batch at its first error.
        const batches = [
          group.filter((intent) => intent.recovery_epoch == null),
          ...group.filter((intent) => intent.recovery_epoch != null).map((intent) => [intent]),
        ].filter((batch) => batch.length > 0);
        for (const batch of batches) {
          const intentIds = batch.map((intent) =>
            intentEventId(
              intent.question_id,
              intent.verifier_kind,
              intent.placement_authority,
              intent.recovery_epoch,
              intent.recovery_attempt,
            ),
          );
          const boundPayload: VerifyDispatchBoundPayload = {
            version: VERIFY_DISPATCH_VERSION,
            verifier_kind: verifier,
            delivery_id: verifyDeliveryJobId(verifier, intentIds),
            question_ids: batch.map((intent) => intent.question_id),
            intent_ids: intentIds,
          };
          for (const [index, intent] of batch.entries()) {
            written.push({
              id: verifyDispatchBoundEventIdForIntent(intentIds[index]),
              actor_kind: 'system',
              actor_ref: 'verify_dispatch_outbox',
              action: VERIFY_DISPATCH_BOUND_ACTION,
              subject_kind: 'question',
              subject_id: intent.question_id,
              outcome: 'success',
              payload: boundPayload,
              created_at: now,
              ingest_at: now,
            });
          }
        }
      }
      for (const intent of terminal) {
        written.push(
          dispatchCompletionEvent(intent, { recovery, disposition: 'terminal_skip', now }),
        );
      }
      await writeEvents(tx, written);

      return { skippedTerminal: terminal.length };
    });

    // Phase 2 — send: outside any transaction, per bound delivery. A send that
    // resolves means the engine accepted the delivery (a duplicate stable id
    // resolves as the pre-existing identical delivery). Per-delivery isolation
    // keeps one engine failure from stalling the page.
    const deliveries = await selectBoundDeliveries(db, {
      recoveryOnly: input.recoveryOnly,
      questionIds: input.questionIds,
      batchSize: input.batchSize,
      now,
    });
    const accepted: BoundVerifyDelivery[] = [];
    let failed = 0;
    for (const delivery of deliveries) {
      try {
        await enqueueBoundDelivery(input.enqueue, delivery);
        accepted.push(delivery);
      } catch (error) {
        failed += delivery.questionIds.length;
        await writeDispatchFailure(db, {
          recovery,
          questionIds: delivery.questionIds,
          error,
        });
      }
    }

    // Phase 3 — ack: the completion event is written only after the engine
    // accepted the delivery. A crash before this commit leaves bound rows that
    // phase 2 re-drives against the same stable delivery id.
    const ackEvents = accepted.flatMap((delivery) =>
      delivery.intents.map((intent) =>
        dispatchCompletionEvent(intent, {
          recovery,
          disposition: 'enqueued',
          deliveryId: delivery.deliveryId,
          now,
        }),
      ),
    );
    if (ackEvents.length > 0) {
      await db.transaction(async (tx) => {
        await writeEvents(tx, ackEvents);
      });
    }

    return {
      synthesized: 0,
      dispatched: accepted.reduce((count, delivery) => count + delivery.intents.length, 0),
      skippedTerminal: bound.skippedTerminal,
      failed,
    };
  } catch (error) {
    await writeDispatchFailure(db, {
      recovery,
      questionIds: input.questionIds,
      error,
    });
    // The locked batch rolled back together. Floor at 1 when the throw came before the lock.
    return { ...empty, failed: input.questionIds?.length ?? Math.max(1, lockedCount) };
  }
}

/** Recoveries spend a per-question 20h attempt window even if enqueue fails.
 * Replacing expired pending attempts avoids both permanent ownership and late double sends. */
export async function recoverOrphanVerifyDispatches(
  db: Db,
  input: {
    enqueue: EnqueueVerifyFn;
    batchSize?: number;
    now?: Date;
    /** Zero-send lane probe (adapter startup only). When provided, a failure
     * skips this sweep's recovery re-drives entirely — a broken lane must not
     * mint paid attempts. Without it the sweep synthesizes orphans only. */
    sourceVerifyRecoveryPreflight?: () => Promise<void>;
  },
): Promise<VerifyDispatchResult> {
  try {
    const now = input.now ?? new Date();
    const batchSize = input.batchSize ?? 500;

    interface RecoveryCandidate {
      questionId: string;
      epoch: string;
      recheckCommandEventId?: string;
      supplyTrace?: unknown;
      placementAuthority?: PlacementVerificationAuthority;
    }

    const { synthesizedIds, candidates } = await db.transaction(async (tx) => {
      const existingIntent = alias(event, 'verify_dispatch_existing_intent');
      const terminalVerify = alias(event, 'verify_dispatch_terminal_verify');
      const selectDrafts = (recoveryArm: boolean) =>
        tx
          .select({ id: question.id, source: question.source, metadata: question.metadata })
          .from(question)
          .where(
            and(
              eq(question.draft_status, 'draft'),
              inArray(question.source, ['quiz_gen', 'web_sourced']),
              sql`NOT ${declaredAdmissionOwned()}`,
              sql`${question.metadata}->>'archived_at' IS NULL`,
              sql`${question.metadata}->>'dismissed_at' IS NULL`,
              // A part is promoted with its parent. An intent here can only skip.
              isNull(question.parent_question_id),
              // Filter owned and terminal rows before LIMIT, or a stuck first page hides later drafts.
              recoveryArm
                ? and(
                    eligibleRecoveryError(question.id, now),
                    noLiveSourceVerifyJob(question.id),
                    eq(question.source, 'web_sourced'),
                    noRecentRecoveryIntent(question.id, now),
                  )
                : and(
                    sql`NOT EXISTS (SELECT 1 FROM ${event} v WHERE v.subject_id = ${question.id}
                AND v.action = 'experimental:source_verify')`,
                    notExists(
                      tx
                        .select({ id: existingIntent.id })
                        .from(existingIntent)
                        .where(
                          and(
                            eq(existingIntent.action, VERIFY_DISPATCH_INTENT_ACTION),
                            eq(existingIntent.subject_id, question.id),
                            isStructurallyDispatchableIntent(existingIntent.payload),
                            sql`${existingIntent.payload}->>'verifier_kind' = CASE WHEN ${question.source} = 'web_sourced' THEN 'source_verify' ELSE 'quiz_verify' END`,
                          ),
                        ),
                    ),
                    notExists(
                      tx
                        .select({ id: terminalVerify.id })
                        .from(terminalVerify)
                        .where(
                          and(
                            eq(terminalVerify.subject_id, question.id),
                            sql`${terminalVerify.action} = CASE WHEN ${question.source} = 'web_sourced' THEN 'experimental:source_verify' ELSE 'experimental:quiz_verify' END`,
                            sql`${terminalVerify.outcome} IS DISTINCT FROM 'error'`,
                          ),
                        ),
                    ),
                  ),
            ),
          )
          .orderBy(
            sql`CASE WHEN ${recoveryArm} THEN (SELECT v.created_at FROM ${event} v
          WHERE v.subject_kind = 'question' AND v.subject_id = ${question.id} AND v.action = 'experimental:source_verify'
          ORDER BY v.created_at DESC, v.dispatch_seq DESC, v.id DESC LIMIT 1) ELSE ${question.created_at} END`,
            question.id,
          )
          .limit(recoveryArm ? SOURCE_VERIFY_RECOVERY_BATCH_SIZE : batchSize)
          .for('update', { skipLocked: true });
      const drafts = [...(await selectDrafts(false)), ...(await selectDrafts(true))];
      const liveDrafts = drafts.filter((row) => !metadataIsArchived(row.metadata));
      if (liveDrafts.length === 0) return { synthesizedIds: [], candidates: [] };
      const ids = liveDrafts.map((row) => row.id);
      const relatedEvents = await tx
        .select({
          id: event.id,
          subjectId: event.subject_id,
          action: event.action,
          outcome: event.outcome,
          payload: event.payload,
          createdAt: event.created_at,
          dispatchSeq: event.dispatch_seq,
        })
        .from(event)
        .where(inArray(event.subject_id, ids));
      const intentsByQuestion = new Map<
        string,
        { payload: VerifyDispatchIntentPayload; createdAt: Date }[]
      >();
      const verifyByQuestion = new Map<string, typeof relatedEvents>();
      for (const row of relatedEvents) {
        if (row.action === VERIFY_DISPATCH_INTENT_ACTION) {
          const parsed = verifyDispatchIntentPayloadSchema.safeParse(row.payload);
          if (parsed.success) {
            const bucket = intentsByQuestion.get(parsed.data.question_id);
            const entry = { payload: parsed.data, createdAt: row.createdAt };
            if (bucket) bucket.push(entry);
            else intentsByQuestion.set(parsed.data.question_id, [entry]);
          }
        } else {
          const bucket = verifyByQuestion.get(row.subjectId);
          if (bucket) bucket.push(row);
          else verifyByQuestion.set(row.subjectId, [row]);
        }
      }
      const synthesized: string[] = [];
      const recovered: RecoveryCandidate[] = [];
      for (const row of liveDrafts) {
        const verifier = row.source === 'web_sourced' ? 'source_verify' : 'quiz_verify';
        const verifyRows = (verifyByQuestion.get(row.id) ?? []).filter(
          (r) => r.action === `experimental:${verifier}`,
        );
        const latestVerify = verifyRows.sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.dispatchSeq - a.dispatchSeq ||
            b.id.localeCompare(a.id),
        )[0];
        const scoped = (intentsByQuestion.get(row.id) ?? []).filter(
          (entry) => entry.payload.verifier_kind === verifier,
        );
        if (
          verifier === 'source_verify' &&
          latestVerify != null &&
          latestVerify.outcome === 'error'
        ) {
          const prior = [...scoped].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          const latestIntent = prior[prior.length - 1]?.payload;
          const errorPayload = latestVerify.payload as Record<string, unknown> | null;
          recovered.push({
            questionId: row.id,
            epoch: latestVerify.id,
            ...(typeof errorPayload?.recheck_command_event_id === 'string'
              ? { recheckCommandEventId: errorPayload.recheck_command_event_id }
              : {}),
            ...(latestIntent?.supply_trace != null
              ? { supplyTrace: latestIntent.supply_trace }
              : {}),
            ...(latestIntent?.placement_authority != null
              ? { placementAuthority: latestIntent.placement_authority }
              : {}),
          });
          continue;
        }
        // Orphan arm: no scoped intent and no terminal verify event.
        if (scoped.length === 0 && !verifyRows.some(isTerminalVerifyEvent)) {
          await writeVerifyDispatchIntent(tx, {
            questionId: row.id,
            verifier,
            createdAt: now,
          });
          synthesized.push(row.id);
        }
      }
      return { synthesizedIds: synthesized, candidates: recovered };
    });

    // The preflight probes lane config without sending (adapter startup only). A
    // broken lane must not mint paid attempts — holds stay held and re-try next sweep.
    const recoverable = [...candidates];
    let recoveryPreflightOk = false;
    if (input.sourceVerifyRecoveryPreflight == null) {
      console.warn(
        '[verify-dispatch-outbox] recovery candidates found but no preflight provided; skipping',
      );
      recoverable.length = 0;
    } else {
      try {
        await input.sourceVerifyRecoveryPreflight();
        recoveryPreflightOk = true;
      } catch (preflightErr) {
        console.warn(
          '[verify-dispatch-outbox] source-verify recovery preflight failed; skipping recovery',
          preflightErr,
        );
        recoverable.length = 0;
      }
    }

    // Between the selection tx and the preflight the world moved: re-lock each
    // candidate and re-check the epoch before writing its intent, so a verify that
    // landed (or a dispatch that appeared) in between wins.
    const recoveredIds = await db.transaction(async (tx) => {
      const written: string[] = [];
      for (const candidate of recoverable) {
        const [row] = await tx
          .select({
            id: question.id,
            source: question.source,
            draftStatus: question.draft_status,
            metadata: question.metadata,
            parentQuestionId: question.parent_question_id,
          })
          .from(question)
          .where(
            and(
              eq(question.id, candidate.questionId),
              eligibleRecoveryError(question.id, now),
              noLiveSourceVerifyJob(question.id),
              noRecentRecoveryIntent(question.id, now),
            ),
          )
          .for('update')
          .limit(1);
        if (
          row == null ||
          row.draftStatus !== 'draft' ||
          row.source !== 'web_sourced' ||
          metadataIsArchived(row.metadata) ||
          row.parentQuestionId != null
        )
          continue;
        const scopedEvents = await tx
          .select({
            id: event.id,
            action: event.action,
            outcome: event.outcome,
            payload: event.payload,
            createdAt: event.created_at,
            dispatchSeq: event.dispatch_seq,
          })
          .from(event)
          .where(
            and(
              eq(event.subject_id, candidate.questionId),
              inArray(event.action, [
                'experimental:source_verify',
                VERIFY_DISPATCH_INTENT_ACTION,
                VERIFY_DISPATCH_COMPLETE_ACTION,
              ]),
            ),
          );
        const verifyRows = scopedEvents.filter((r) => r.action === 'experimental:source_verify');
        const latestVerify = verifyRows.sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.dispatchSeq - a.dispatchSeq ||
            b.id.localeCompare(a.id),
        )[0];
        if (latestVerify == null || latestVerify.id !== candidate.epoch) continue;
        const recoveryIntents = scopedEvents.filter(
          (r) =>
            r.action === VERIFY_DISPATCH_INTENT_ACTION &&
            (r.payload as Record<string, unknown> | null)?.verifier_kind === 'source_verify' &&
            (r.payload as Record<string, unknown> | null)?.recovery_epoch != null,
        );
        if (
          recoveryIntents.some(
            (i) => i.createdAt.getTime() > now.getTime() - SOURCE_VERIFY_RECOVERY_MIN_AGE_MS,
          )
        )
          continue;
        await writeVerifyDispatchIntent(tx, {
          questionId: candidate.questionId,
          verifier: 'source_verify',
          supplyTrace: candidate.supplyTrace,
          placementAuthority: candidate.placementAuthority,
          recoveryEpoch: candidate.epoch,
          recoveryAttempt: recoveryIntents.length + 1,
          recheckCommandEventId: candidate.recheckCommandEventId,
          createdAt: now,
        });
        written.push(candidate.questionId);
      }
      return written;
    });

    const dispatched = await dispatchPendingVerifyIntents(db, {
      enqueue: input.enqueue,
      recovery: true,
      batchSize,
      now,
    });
    const recoveryDispatched = recoveryPreflightOk
      ? await dispatchPendingVerifyIntents(db, {
          enqueue: input.enqueue,
          recovery: true,
          recoveryOnly: true,
          questionIds: recoveredIds,
          batchSize: SOURCE_VERIFY_RECOVERY_BATCH_SIZE,
          now,
        })
      : { synthesized: 0, dispatched: 0, skippedTerminal: 0, failed: 0 };
    return {
      synthesized: synthesizedIds.length + recoveredIds.length,
      dispatched: dispatched.dispatched + recoveryDispatched.dispatched,
      skippedTerminal: dispatched.skippedTerminal + recoveryDispatched.skippedTerminal,
      failed: dispatched.failed + recoveryDispatched.failed,
    };
  } catch (error) {
    console.error(
      '[verify-dispatch-outbox] recovery eligibility query failed; leaving intents pending',
      error,
    );
    return { synthesized: 0, dispatched: 0, skippedTerminal: 0, failed: 1 };
  }
}
