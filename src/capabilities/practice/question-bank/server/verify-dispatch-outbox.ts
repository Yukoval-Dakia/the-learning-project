import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { type AnyColumn, and, eq, exists, inArray, isNull, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { event, question } from '@/db/schema';
import type { WriteEventInput } from '@/kernel/events/index';
import { writeEvent, writeEvents } from '@/kernel/events/index';
import type { PlacementVerificationAuthority } from '@/kernel/supply-contracts';

export const VERIFY_DISPATCH_INTENT_ACTION = 'experimental:verify_dispatch_intent';
export const VERIFY_DISPATCH_COMPLETE_ACTION = 'experimental:verify_dispatch';
export const VERIFY_DISPATCH_VERSION = 1 as const;

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
  /** Copied from the recovered error event so the run consults that command's
   * paid-effect claim instead of re-paying under it. */
  recheck_command_event_id: z.string().min(1).optional(),
});

type VerifyDispatchIntentPayload = z.infer<typeof verifyDispatchIntentPayloadSchema>;

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
  kind: 'intent' | 'complete',
  questionId: string,
  verifier: VerifyKind,
  authority?: PlacementVerificationAuthority,
  recoveryEpoch?: string,
) {
  const digest = createHash('sha256')
    .update(
      `${verifier}\0${questionId}${placementAuthorityIdentity(authority)}` +
        (recoveryEpoch != null ? `\0${recoveryEpoch}` : ''),
    )
    .digest('hex');
  return `verify-dispatch-${kind}-v${VERIFY_DISPATCH_VERSION_TAG}-${digest}`;
}

function intentEventId(
  questionId: string,
  verifier: VerifyKind,
  authority?: PlacementVerificationAuthority,
  recoveryEpoch?: string,
) {
  return stableEventId('intent', questionId, verifier, authority, recoveryEpoch);
}

function completeEventId(
  questionId: string,
  verifier: VerifyKind,
  authority?: PlacementVerificationAuthority,
  recoveryEpoch?: string,
) {
  return stableEventId('complete', questionId, verifier, authority, recoveryEpoch);
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
    /** Sweep recovery only: the error event being re-driven. One intent exists
     * per (question, verifier, authority, epoch) — a new error re-arms, the
     * same error cannot dispatch twice. */
    recoveryEpoch?: string;
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
    ...(input.recheckCommandEventId != null
      ? { recheck_command_event_id: input.recheckCommandEventId }
      : {}),
  });
  const id = intentEventId(
    input.questionId,
    input.verifier,
    input.placementAuthority,
    input.recoveryEpoch,
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
  input: { recovery: boolean; disposition: 'enqueued' | 'terminal_skip'; now: Date },
): WriteEventInput {
  return {
    id: completeEventId(
      intent.question_id,
      intent.verifier_kind,
      intent.placement_authority,
      intent.recovery_epoch,
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
      ...(intent.supply_trace ? { supply_trace: intent.supply_trace } : {}),
      ...(intent.placement_authority ? { placement_authority: intent.placement_authority } : {}),
      ...(intent.recovery_epoch != null ? { recovery_epoch: intent.recovery_epoch } : {}),
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

export async function dispatchPendingVerifyIntents(
  db: Db,
  input: {
    enqueue: EnqueueVerifyFn;
    questionIds?: string[];
    recovery?: boolean;
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
    return await db.transaction(async (tx) => {
      const completion = alias(event, 'verify_dispatch_completion');
      const predicates = [
        eq(event.action, VERIFY_DISPATCH_INTENT_ACTION),
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
              ),
            ),
        ),
      ];
      if (input.questionIds) predicates.push(inArray(event.subject_id, input.questionIds));
      const locked = await tx
        .select({ id: event.id, subjectId: event.subject_id, payload: event.payload })
        .from(event)
        .where(and(...predicates))
        .orderBy(event.created_at, event.id)
        .limit(input.batchSize ?? 100)
        .for('update', { skipLocked: true });
      lockedCount = locked.length;
      if (locked.length === 0) return empty;

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
          // A part has no verify of its own. The parent's cascade owns it. Drain a stray intent instead of enqueueing a job that can only skip.
          row.parentQuestionId != null ||
          terminalHit(intent)
        ) {
          terminal.push(intent);
        } else {
          eligible.push(intent);
        }
      }

      const completionEvents: WriteEventInput[] = [];
      for (const verifier of verifyKindSchema.options) {
        const group = eligible.filter((intent) => intent.verifier_kind === verifier);
        if (group.length === 0) continue;
        const placementAuthorities = group.flatMap((intent) =>
          intent.placement_authority ? [intent.placement_authority] : [],
        );
        const recoveryMarks: Record<string, VerifyRecoveryMark> = {};
        for (const intent of group) {
          if (intent.recovery_epoch != null) {
            recoveryMarks[intent.question_id] = {
              epoch: intent.recovery_epoch,
              ...(intent.recheck_command_event_id != null
                ? { recheck_command_event_id: intent.recheck_command_event_id }
                : {}),
            };
          }
        }
        await input.enqueue(
          verifier,
          group.map((intent) => intent.question_id),
          { db: fromPgBossDrizzleTx(tx) },
          placementAuthorities.length > 0 ? placementAuthorities : undefined,
          Object.keys(recoveryMarks).length > 0 ? recoveryMarks : undefined,
        );
        for (const intent of group) {
          completionEvents.push(
            dispatchCompletionEvent(intent, { recovery, disposition: 'enqueued', now }),
          );
        }
      }
      for (const intent of terminal) {
        completionEvents.push(
          dispatchCompletionEvent(intent, { recovery, disposition: 'terminal_skip', now }),
        );
      }
      await writeEvents(tx, completionEvents);

      return {
        synthesized: 0,
        dispatched: eligible.length,
        skippedTerminal: terminal.length,
        failed: 0,
      };
    });
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

/**
 * Startup/nightly repair: synthesize intents for legacy orphan drafts AND re-drive
 * source-verify holds whose LATEST source_verify event is an error (config fault,
 * 429, 5xx — any transient). An older terminal verdict followed by a newer error is
 * recoverable; a latest terminal event is never re-run. Each error event is one
 * recovery epoch: the intent carries its id, so the same error cannot dispatch
 * twice and the next error re-arms. The recovery intent copies the error event's
 * recheck command id and the latest prior intent's placement authority, so the
 * re-run stays inside the paid-effect claim and the claim ledger; a stale
 * authority fails closed inside the run. It never invokes sourcing or generation.
 */
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
    const latestErr = alias(event, 'verify_recovery_latest_err');
    const newerVerify = alias(event, 'verify_recovery_newer');
    const epochIntent = alias(event, 'verify_recovery_epoch_intent');
    const incompleteIntent = alias(event, 'verify_recovery_incomplete_intent');
    const incompleteCompletion = alias(event, 'verify_recovery_incomplete_completion');
    const drafts = await tx
      .select({ id: question.id, source: question.source, metadata: question.metadata })
      .from(question)
      .where(
        and(
          eq(question.draft_status, 'draft'),
          inArray(question.source, ['quiz_gen', 'web_sourced']),
          sql`${question.metadata}->>'archived_at' IS NULL`,
          sql`${question.metadata}->>'dismissed_at' IS NULL`,
          // A part is promoted with its parent. An intent here can only skip.
          isNull(question.parent_question_id),
          // Filter owned and terminal rows before LIMIT, or a stuck first page hides later drafts.
          or(
            // Orphan arm: no dispatchable intent and no terminal verify event.
            and(
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
            // Recovery arm (source_verify only): the latest source_verify event is
            // an error, no intent already carries that epoch, and no scoped intent
            // is still in flight. An incomplete intent is not owned — but it is
            // pending, and the drain owns it, so it suppresses a second dispatch.
            and(
              eq(question.source, 'web_sourced'),
              exists(
                tx
                  .select({ id: latestErr.id })
                  .from(latestErr)
                  .where(
                    and(
                      eq(latestErr.action, 'experimental:source_verify'),
                      eq(latestErr.subject_id, question.id),
                      eq(latestErr.outcome, 'error'),
                      notExists(
                        tx
                          .select({ id: newerVerify.id })
                          .from(newerVerify)
                          .where(
                            and(
                              eq(newerVerify.action, 'experimental:source_verify'),
                              eq(newerVerify.subject_id, question.id),
                              sql`(${newerVerify.created_at}, ${newerVerify.id}) > (${latestErr.created_at}, ${latestErr.id})`,
                            ),
                          ),
                      ),
                    ),
                  ),
              ),
              notExists(
                tx
                  .select({ id: epochIntent.id })
                  .from(epochIntent)
                  .where(
                    and(
                      eq(epochIntent.action, VERIFY_DISPATCH_INTENT_ACTION),
                      eq(epochIntent.subject_id, question.id),
                      sql`${epochIntent.payload}->>'verifier_kind' = 'source_verify'`,
                      sql`${epochIntent.payload}->>'recovery_epoch' = (
                        SELECT e2.id FROM ${event} e2
                        WHERE e2.action = 'experimental:source_verify'
                          AND e2.subject_id = ${question.id}
                        ORDER BY e2.created_at DESC, e2.id DESC LIMIT 1
                      )`,
                    ),
                  ),
              ),
              notExists(
                tx
                  .select({ id: incompleteIntent.id })
                  .from(incompleteIntent)
                  .where(
                    and(
                      eq(incompleteIntent.action, VERIFY_DISPATCH_INTENT_ACTION),
                      eq(incompleteIntent.subject_id, question.id),
                      isStructurallyDispatchableIntent(incompleteIntent.payload),
                      sql`${incompleteIntent.payload}->>'verifier_kind' = 'source_verify'`,
                      notExists(
                        tx
                          .select({ id: incompleteCompletion.id })
                          .from(incompleteCompletion)
                          .where(
                            and(
                              eq(incompleteCompletion.action, VERIFY_DISPATCH_COMPLETE_ACTION),
                              eq(incompleteCompletion.subject_id, incompleteIntent.subject_id),
                              sql`${incompleteCompletion.payload}->>'verifier_kind' = 'source_verify'`,
                              sql`COALESCE(${incompleteCompletion.payload}->'placement_authority', 'null'::jsonb) = COALESCE(${incompleteIntent.payload}->'placement_authority', 'null'::jsonb)`,
                              sql`COALESCE(${incompleteCompletion.payload}->>'recovery_epoch', '') = COALESCE(${incompleteIntent.payload}->>'recovery_epoch', '')`,
                            ),
                          ),
                      ),
                    ),
                  ),
              ),
            ),
          ),
        ),
      )
      .orderBy(question.created_at, question.id)
      .limit(batchSize)
      .for('update', { skipLocked: true });
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
      })
      .from(event)
      .where(inArray(event.subject_id, ids));
    const intentsByQuestion = new Map<
      string,
      { payload: VerifyDispatchIntentPayload; createdAt: Date }[]
    >();
    const verifyByQuestion = new Map<string, typeof relatedEvents>();
    const completionKeys = new Set<string>();
    const intentKey = (p: {
      question_id: string;
      verifier_kind: VerifyKind;
      placement_authority?: PlacementVerificationAuthority;
      recovery_epoch?: string;
    }) =>
      `${p.question_id}\0${p.verifier_kind}${placementAuthorityIdentity(p.placement_authority)}\0${p.recovery_epoch ?? ''}`;
    for (const row of relatedEvents) {
      if (row.action === VERIFY_DISPATCH_INTENT_ACTION) {
        const parsed = verifyDispatchIntentPayloadSchema.safeParse(row.payload);
        if (parsed.success) {
          const bucket = intentsByQuestion.get(parsed.data.question_id);
          const entry = { payload: parsed.data, createdAt: row.createdAt };
          if (bucket) bucket.push(entry);
          else intentsByQuestion.set(parsed.data.question_id, [entry]);
        }
      } else if (row.action === VERIFY_DISPATCH_COMPLETE_ACTION) {
        const p = row.payload as {
          question_id?: unknown;
          verifier_kind?: unknown;
          placement_authority?: PlacementVerificationAuthority;
          recovery_epoch?: unknown;
        } | null;
        if (
          p != null &&
          typeof p.question_id === 'string' &&
          verifyKindSchema.safeParse(p.verifier_kind).success
        ) {
          completionKeys.add(
            intentKey({
              question_id: p.question_id,
              verifier_kind: p.verifier_kind as VerifyKind,
              placement_authority: p.placement_authority,
              recovery_epoch: typeof p.recovery_epoch === 'string' ? p.recovery_epoch : undefined,
            }),
          );
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
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      )[0];
      const scoped = (intentsByQuestion.get(row.id) ?? []).filter(
        (entry) => entry.payload.verifier_kind === verifier,
      );
      // A pending (incomplete) intent owns the row: the drain decides its fate.
      if (scoped.some((entry) => !completionKeys.has(intentKey(entry.payload)))) continue;
      if (
        verifier === 'source_verify' &&
        latestVerify != null &&
        latestVerify.outcome === 'error'
      ) {
        // Recovery arm: latest is an error → one epoch-marked intent re-drives it.
        if (scoped.some((entry) => entry.payload.recovery_epoch === latestVerify.id)) continue;
        const prior = [...scoped].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const latestIntent = prior[prior.length - 1]?.payload;
        const errorPayload = latestVerify.payload as Record<string, unknown> | null;
        recovered.push({
          questionId: row.id,
          epoch: latestVerify.id,
          ...(typeof errorPayload?.recheck_command_event_id === 'string'
            ? { recheckCommandEventId: errorPayload.recheck_command_event_id }
            : {}),
          ...(latestIntent?.supply_trace != null ? { supplyTrace: latestIntent.supply_trace } : {}),
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
  if (recoverable.length > 0) {
    if (input.sourceVerifyRecoveryPreflight == null) {
      console.warn(
        '[verify-dispatch-outbox] recovery candidates found but no preflight provided; skipping',
      );
      recoverable.length = 0;
    } else {
      try {
        await input.sourceVerifyRecoveryPreflight();
      } catch (preflightErr) {
        console.warn(
          '[verify-dispatch-outbox] source-verify recovery preflight failed; skipping recovery',
          preflightErr,
        );
        recoverable.length = 0;
      }
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
        .where(eq(question.id, candidate.questionId))
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
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      )[0];
      if (latestVerify == null || latestVerify.id !== candidate.epoch) continue;
      const intents = scopedEvents
        .filter((r) => r.action === VERIFY_DISPATCH_INTENT_ACTION)
        .map((r) => verifyDispatchIntentPayloadSchema.safeParse(r.payload))
        .filter((r) => r.success)
        .map((r) => r.data)
        .filter((i) => i.verifier_kind === 'source_verify');
      const completionKeys = new Set(
        scopedEvents
          .filter((r) => r.action === VERIFY_DISPATCH_COMPLETE_ACTION)
          .map((r) => {
            const p = r.payload as {
              question_id?: unknown;
              placement_authority?: PlacementVerificationAuthority;
              recovery_epoch?: unknown;
            } | null;
            return `${p?.question_id ?? ''}\0source_verify${placementAuthorityIdentity(p?.placement_authority)}\0${typeof p?.recovery_epoch === 'string' ? p.recovery_epoch : ''}`;
          }),
      );
      const intentKey = (p: {
        question_id: string;
        placement_authority?: PlacementVerificationAuthority;
        recovery_epoch?: string;
      }) =>
        `${p.question_id}\0source_verify${placementAuthorityIdentity(p.placement_authority)}\0${p.recovery_epoch ?? ''}`;
      if (intents.some((i) => i.recovery_epoch === candidate.epoch)) continue;
      if (intents.some((i) => !completionKeys.has(intentKey(i)))) continue;
      await writeVerifyDispatchIntent(tx, {
        questionId: candidate.questionId,
        verifier: 'source_verify',
        supplyTrace: candidate.supplyTrace,
        placementAuthority: candidate.placementAuthority,
        recoveryEpoch: candidate.epoch,
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
  return { ...dispatched, synthesized: synthesizedIds.length + recoveredIds.length };
}
