import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { recordQuestionPoolGap } from './notes';

const QUIZ_VERIFY_ACTION = 'experimental:quiz_verify';
const POOL_GAP_STATUSES = ['needs_review', 'failed'] as const;

type PoolGapStatus = (typeof POOL_GAP_STATUSES)[number];

interface VerifyEventRow {
  id: string;
  action: string;
  subject_id: string;
  outcome: string | null;
  payload: unknown;
  task_run_id: string | null;
  created_at: Date;
}

type PoolGapSignal =
  | {
      kind: 'gap';
      questionId: string;
      verificationStatus: PoolGapStatus;
      confidence: number;
      taskRunId: string | null;
      observedAt: Date;
      verificationEventId: string;
    }
  | { kind: 'ignore'; reason: string };

function isPoolGapStatus(value: unknown): value is PoolGapStatus {
  return (POOL_GAP_STATUSES as readonly unknown[]).includes(value);
}

function payloadFields(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

/**
 * A committed quiz verification is a pool-gap signal only when it records a
 * terminal non-promotion. outcome=error is the retryable failure-bottom and
 * never opened a hint; a missing promotion flag is that same bottom.
 */
function readQuizVerifyPoolGap(row: VerifyEventRow): PoolGapSignal {
  if (row.action !== QUIZ_VERIFY_ACTION) {
    return { kind: 'ignore', reason: `unexpected source action '${row.action}'` };
  }
  if (row.outcome === 'error') {
    return { kind: 'ignore', reason: 'transient verify error is retried and is not a pool gap' };
  }
  const payload = payloadFields(row.payload);
  if (payload?.promoted !== false) {
    return {
      kind: 'ignore',
      reason:
        payload?.promoted === true
          ? 'question entered the review pool'
          : 'verification did not record a non-promotion',
    };
  }
  if (!isPoolGapStatus(payload.verification_status)) {
    return { kind: 'ignore', reason: 'non-promotion verification status is not a pool gap' };
  }
  if (typeof payload.confidence !== 'number' || !Number.isFinite(payload.confidence)) {
    return { kind: 'ignore', reason: 'pool-gap verification has no confidence' };
  }
  if (row.subject_id.trim().length === 0) {
    return { kind: 'ignore', reason: 'quiz verify event has no question id' };
  }
  return {
    kind: 'gap',
    questionId: row.subject_id,
    verificationStatus: payload.verification_status,
    confidence: payload.confidence,
    taskRunId: row.task_run_id,
    observedAt: row.created_at,
    verificationEventId: row.id,
  };
}

async function poolGapAlreadyRecorded(db: Db, verificationEventId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:agent_note'),
        eq(event.caused_by_event_id, verificationEventId),
        sql`${event.payload}->>'signal_kind' = 'question_pool_gap'`,
      ),
    )
    .limit(1);
  return existing !== undefined;
}

export async function handleQuestionPoolGapDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
): Promise<EventSubscriptionOutcome> {
  const [row] = await db
    .select({
      id: event.id,
      action: event.action,
      subject_id: event.subject_id,
      outcome: event.outcome,
      payload: event.payload,
      task_run_id: event.task_run_id,
      created_at: event.created_at,
    })
    .from(event)
    .where(eq(event.id, delivery.sourceEventId))
    .limit(1);
  if (!row) throw new Error(`quiz verify event '${delivery.sourceEventId}' was not found`);

  const signal = readQuizVerifyPoolGap(row);
  if (signal.kind === 'ignore') return { status: 'skipped', reason: signal.reason };
  if (await poolGapAlreadyRecorded(db, signal.verificationEventId)) {
    return { status: 'skipped', reason: 'question pool gap note already recorded' };
  }

  const [questionRow] = await db
    .select({ knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(eq(question.id, signal.questionId))
    .limit(1);

  await recordQuestionPoolGap(db, {
    questionId: signal.questionId,
    knowledgeIds: questionRow?.knowledge_ids ?? null,
    verificationStatus: signal.verificationStatus,
    confidence: signal.confidence,
    taskRunId: signal.taskRunId,
    verificationEventId: signal.verificationEventId,
    observedAt: signal.observedAt,
  });
  return { status: 'succeeded' };
}

export const buildQuestionPoolGapSubscriber: EventSubscriptionHandlerFactory = (db) => {
  return (delivery) => handleQuestionPoolGapDelivery(db, delivery);
};
