import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { type AnyColumn, and, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import type { WriteEventInput } from '@/kernel/events';
import { writeEvent, writeEvents } from '@/kernel/events';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
import type { PlacementVerificationAuthority } from './question-supply/placement-starter-attempts';

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
});

type VerifyDispatchIntentPayload = z.infer<typeof verifyDispatchIntentPayloadSchema>;

export type EnqueueVerifyFn = (
  verifier: VerifyKind,
  questionIds: string[],
  options?: object,
  placementAuthorities?: PlacementVerificationAuthority[],
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
) {
  const digest = createHash('sha256')
    .update(`${verifier}\0${questionId}${placementAuthorityIdentity(authority)}`)
    .digest('hex');
  return `verify-dispatch-${kind}-v${VERIFY_DISPATCH_VERSION_TAG}-${digest}`;
}

function intentEventId(
  questionId: string,
  verifier: VerifyKind,
  authority?: PlacementVerificationAuthority,
) {
  return stableEventId('intent', questionId, verifier, authority);
}

function completeEventId(
  questionId: string,
  verifier: VerifyKind,
  authority?: PlacementVerificationAuthority,
) {
  return stableEventId('complete', questionId, verifier, authority);
}

function metadataIsArchived(metadata: unknown): boolean {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    (metadata as Record<string, unknown>).archived_at != null
  );
}

function isTerminalVerifyEvent(row: { action: string; outcome: string | null }): boolean {
  return (
    (row.action === 'experimental:quiz_verify' || row.action === 'experimental:source_verify') &&
    row.outcome !== 'error'
  );
}

function terminalVerifyKey(subjectId: string, action: string): string {
  const verifier = action === 'experimental:source_verify' ? 'source_verify' : 'quiz_verify';
  return `${subjectId}\0${verifier}`;
}

export async function writeVerifyDispatchIntent(
  db: Db | Tx,
  input: {
    questionId: string;
    verifier: VerifyKind;
    supplyTrace?: unknown;
    placementAuthority?: PlacementVerificationAuthority;
    createdAt?: Date;
  },
): Promise<string> {
  const payload: VerifyDispatchIntentPayload = verifyDispatchIntentPayloadSchema.parse({
    version: VERIFY_DISPATCH_VERSION,
    verifier_kind: input.verifier,
    question_id: input.questionId,
    ...(input.supplyTrace ? { supply_trace: input.supplyTrace } : {}),
    ...(input.placementAuthority ? { placement_authority: input.placementAuthority } : {}),
  });
  const id = intentEventId(input.questionId, input.verifier, input.placementAuthority);
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
    id: completeEventId(intent.question_id, intent.verifier_kind, intent.placement_authority),
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
        .select({ subjectId: event.subject_id, action: event.action, outcome: event.outcome })
        .from(event)
        .where(
          and(
            inArray(event.subject_id, questionIds),
            inArray(event.action, ['experimental:quiz_verify', 'experimental:source_verify']),
          ),
        );
      const terminalKeys = new Set(
        verifyRows
          .filter(isTerminalVerifyEvent)
          .map((row) => terminalVerifyKey(row.subjectId, row.action)),
      );

      const terminal: VerifyDispatchIntentPayload[] = [];
      const eligible: VerifyDispatchIntentPayload[] = [];
      for (const intent of pending) {
        const row = questions.get(intent.question_id);
        if (
          !row ||
          row.draftStatus !== 'draft' ||
          metadataIsArchived(row.metadata) ||
          // A part has no verify of its own. The parent's cascade owns it. Drain a stray intent instead of enqueueing a job that can only skip.
          row.parentQuestionId != null ||
          terminalKeys.has(`${intent.question_id}\0${intent.verifier_kind}`)
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
        if (placementAuthorities.length > 0) {
          await input.enqueue(
            verifier,
            group.map((intent) => intent.question_id),
            { db: fromPgBossDrizzleTx(tx) },
            placementAuthorities,
          );
        } else {
          await input.enqueue(
            verifier,
            group.map((intent) => intent.question_id),
            { db: fromPgBossDrizzleTx(tx) },
          );
        }
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
 * Startup/nightly repair: synthesize intents for legacy orphan drafts, then drain only the
 * verify outbox. It never invokes sourcing or generation.
 */
export async function recoverOrphanVerifyDispatches(
  db: Db,
  input: { enqueue: EnqueueVerifyFn; batchSize?: number; now?: Date },
): Promise<VerifyDispatchResult> {
  const now = input.now ?? new Date();
  const synthesizedIds = await db.transaction(async (tx) => {
    const existingIntent = alias(event, 'verify_dispatch_existing_intent');
    const terminalVerify = alias(event, 'verify_dispatch_terminal_verify');
    const drafts = await tx
      .select({ id: question.id, source: question.source, metadata: question.metadata })
      .from(question)
      .where(
        and(
          eq(question.draft_status, 'draft'),
          inArray(question.source, ['quiz_gen', 'web_sourced']),
          sql`${question.metadata}->>'archived_at' IS NULL`,
          // A part is promoted with its parent. An intent here can only skip.
          isNull(question.parent_question_id),
          // Filter owned and terminal rows before LIMIT, or a stuck first page hides later drafts.
          // An incomplete intent is not owned. Counting it would block the valid replacement.
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
      )
      .orderBy(question.created_at, question.id)
      .limit(input.batchSize ?? 500)
      .for('update', { skipLocked: true });
    const liveDrafts = drafts.filter((row) => !metadataIsArchived(row.metadata));
    if (liveDrafts.length === 0) return [];
    const ids = liveDrafts.map((row) => row.id);
    const relatedEvents = await tx
      .select({
        subjectId: event.subject_id,
        action: event.action,
        outcome: event.outcome,
        payload: event.payload,
      })
      .from(event)
      .where(inArray(event.subject_id, ids));
    const intentKeys = new Set(
      relatedEvents
        .filter((row) => row.action === VERIFY_DISPATCH_INTENT_ACTION)
        .map((row) => verifyDispatchIntentPayloadSchema.safeParse(row.payload))
        .filter((result) => result.success)
        .map((result) => `${result.data.question_id}\0${result.data.verifier_kind}`),
    );
    const terminalKeys = new Set(
      relatedEvents
        .filter(isTerminalVerifyEvent)
        .map((row) => terminalVerifyKey(row.subjectId, row.action)),
    );
    const synthesized: string[] = [];
    for (const row of liveDrafts) {
      const verifier = row.source === 'web_sourced' ? 'source_verify' : 'quiz_verify';
      const key = `${row.id}\0${verifier}`;
      if (intentKeys.has(key) || terminalKeys.has(key)) continue;
      await writeVerifyDispatchIntent(tx, {
        questionId: row.id,
        verifier,
        createdAt: now,
      });
      synthesized.push(row.id);
    }
    return synthesized;
  });

  const dispatched = await dispatchPendingVerifyIntents(db, {
    enqueue: input.enqueue,
    recovery: true,
    batchSize: input.batchSize ?? 500,
    now,
  });
  return { ...dispatched, synthesized: synthesizedIds.length };
}
