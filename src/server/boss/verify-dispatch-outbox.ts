import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Job } from 'pg-boss';
import { z } from 'zod';

import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { fromPgBossDrizzleTx } from './pg-boss-drizzle';

export const VERIFY_DISPATCH_INTENT_ACTION = 'experimental:verify_dispatch_intent';
export const VERIFY_DISPATCH_COMPLETE_ACTION = 'experimental:verify_dispatch';
export const VERIFY_DISPATCH_RECOVERY_QUEUE = 'verify_dispatch_recover';
export const VERIFY_DISPATCH_VERSION = 1 as const;

export const verifyKindSchema = z.enum(['quiz_verify', 'source_verify']);
export type VerifyKind = z.infer<typeof verifyKindSchema>;

const verifyDispatchIntentPayloadSchema = z.object({
  version: z.literal(VERIFY_DISPATCH_VERSION),
  verifier_kind: verifyKindSchema,
  question_id: z.string().min(1),
  supply_trace: z.record(z.string(), z.unknown()).optional(),
});

type VerifyDispatchIntentPayload = z.infer<typeof verifyDispatchIntentPayloadSchema>;

export type EnqueueVerifyFn = (
  verifier: VerifyKind,
  questionIds: string[],
  options?: object,
) => Promise<void>;

export interface VerifyDispatchResult {
  synthesized: number;
  dispatched: number;
  skippedTerminal: number;
  failed: number;
}

function stableEventId(kind: 'intent' | 'complete', questionId: string, verifier: VerifyKind) {
  const digest = createHash('sha256').update(`${verifier}\0${questionId}`).digest('hex');
  return `verify-dispatch-${kind}-${digest}`;
}

function intentEventId(questionId: string, verifier: VerifyKind) {
  return stableEventId('intent', questionId, verifier);
}

function completeEventId(questionId: string, verifier: VerifyKind) {
  return stableEventId('complete', questionId, verifier);
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
    createdAt?: Date;
  },
): Promise<string> {
  const payload: VerifyDispatchIntentPayload = verifyDispatchIntentPayloadSchema.parse({
    version: VERIFY_DISPATCH_VERSION,
    verifier_kind: input.verifier,
    question_id: input.questionId,
    ...(input.supplyTrace ? { supply_trace: input.supplyTrace } : {}),
  });
  return writeEvent(db, {
    id: intentEventId(input.questionId, input.verifier),
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

async function writeDispatchCompletion(
  tx: Tx,
  intent: VerifyDispatchIntentPayload,
  input: { recovery: boolean; disposition: 'enqueued' | 'terminal_skip'; now: Date },
) {
  await writeEvent(tx, {
    id: completeEventId(intent.question_id, intent.verifier_kind),
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
    },
    created_at: input.now,
    ingest_at: input.now,
  });
}

async function writeDispatchFailure(
  db: Db,
  input: { recovery: boolean; questionIds?: string[]; error: unknown },
) {
  try {
    const now = new Date();
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
        error: String(input.error instanceof Error ? input.error.message : input.error),
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
  try {
    return await db.transaction(async (tx) => {
      const completion = alias(event, 'verify_dispatch_completion');
      const predicates = [
        eq(event.action, VERIFY_DISPATCH_INTENT_ACTION),
        // Filter completion rows before LIMIT. Otherwise an old first page of completed intents
        // permanently starves later pending work because every drain locks the same no-op page.
        notExists(
          tx
            .select({ id: completion.id })
            .from(completion)
            .where(
              and(
                eq(completion.action, VERIFY_DISPATCH_COMPLETE_ACTION),
                eq(completion.subject_id, event.subject_id),
                sql`${completion.payload}->>'verifier_kind' = ${event.payload}->>'verifier_kind'`,
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
      if (locked.length === 0) return empty;

      // safeParse (not parse): one corrupt or future-version intent payload must not throw and
      // abort the whole transaction — that would starve every other pending intent in the locked
      // page. Skip the unparseable rows, mirroring the recovery path below.
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
          terminalKeys.has(`${intent.question_id}\0${intent.verifier_kind}`)
        ) {
          terminal.push(intent);
        } else {
          eligible.push(intent);
        }
      }

      for (const verifier of verifyKindSchema.options) {
        const group = eligible.filter((intent) => intent.verifier_kind === verifier);
        if (group.length === 0) continue;
        await input.enqueue(
          verifier,
          group.map((intent) => intent.question_id),
          { db: fromPgBossDrizzleTx(tx) },
        );
        for (const intent of group) {
          await writeDispatchCompletion(tx, intent, { recovery, disposition: 'enqueued', now });
        }
      }
      for (const intent of terminal) {
        await writeDispatchCompletion(tx, intent, {
          recovery,
          disposition: 'terminal_skip',
          now,
        });
      }

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
    return { ...empty, failed: input.questionIds?.length ?? 1 };
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
          // Filter already-owned/terminal rows before LIMIT. A persistent oldest page must not
          // prevent later legacy drafts from ever receiving an intent.
          notExists(
            tx
              .select({ id: existingIntent.id })
              .from(existingIntent)
              .where(
                and(
                  eq(existingIntent.action, VERIFY_DISPATCH_INTENT_ACTION),
                  eq(existingIntent.subject_id, question.id),
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

export function buildVerifyDispatchRecoveryHandler(
  db: Db,
  enqueue: EnqueueVerifyFn,
): (jobs: Job<object>[]) => Promise<void> {
  return async () => {
    await recoverOrphanVerifyDispatches(db, { enqueue });
  };
}
