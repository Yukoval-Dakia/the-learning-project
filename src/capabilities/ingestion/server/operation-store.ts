import { and, asc, desc, eq, sql } from 'drizzle-orm';

import type { IngestionOperationKind } from '@/capabilities/ingestion/api/operation-schema';
import type { Db } from '@/db/client';
import { job_events, learning_session } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';

export const INGESTION_OPERATION_TABLE = 'ingestion_operation';

export type IngestionOperationStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface IngestionOperationError {
  code: string;
  message: string;
  status: number;
}

export interface IngestionOperationResource {
  id: string;
  kind: 'ingestion_operation';
  operation_kind: IngestionOperationKind;
  status: IngestionOperationStatus;
  session_id: string;
  job_id?: string;
  result?: unknown;
  error?: IngestionOperationError;
  created_at: string;
  updated_at: string;
  events_url: string;
}

interface ReserveInput {
  operationId: string;
  sessionId: string;
  operationKind: IngestionOperationKind;
  inputHash: string;
  idempotencyKey?: string;
}

export type ReserveResult =
  | { outcome: 'created'; operationId: string }
  | { outcome: 'reused'; operationId: string }
  | { outcome: 'conflict'; operationId: string };

export interface IdempotentOperationMatch {
  operationId: string;
  operationKind: string | undefined;
  inputHash: string | undefined;
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

export async function findIdempotentIngestionOperation(
  db: Db,
  input: { sessionId: string; idempotencyKey: string },
): Promise<IdempotentOperationMatch | null> {
  const rows = await db
    .select({ businessId: job_events.business_id, payload: job_events.payload })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, INGESTION_OPERATION_TABLE),
        eq(job_events.event_type, 'operation.accepted'),
        sql`${job_events.payload}->>'session_id' = ${input.sessionId}`,
        sql`${job_events.payload}->>'idempotency_key' = ${input.idempotencyKey}`,
      ),
    )
    .orderBy(desc(job_events.id))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        operationId: row.businessId,
        operationKind: payloadString(row.payload, 'operation_kind'),
        inputHash: payloadString(row.payload, 'input_hash'),
      }
    : null;
}

/**
 * 原子保留 operation handle。Idempotency-Key 只在同一 session 的 operations
 * collection 内作用；相同 key + 相同规范化输入复用 handle，不同输入返回冲突。
 */
export async function reserveIngestionOperation(
  db: Db,
  input: ReserveInput,
): Promise<ReserveResult> {
  return db.transaction(async (tx) => {
    if (input.idempotencyKey) {
      const scope = `ingestion-operation:${input.sessionId}:${input.idempotencyKey}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${scope}))`);

      const existingRows = await tx
        .select({ businessId: job_events.business_id, payload: job_events.payload })
        .from(job_events)
        .where(
          and(
            eq(job_events.business_table, INGESTION_OPERATION_TABLE),
            eq(job_events.event_type, 'operation.accepted'),
            sql`${job_events.payload}->>'session_id' = ${input.sessionId}`,
            sql`${job_events.payload}->>'idempotency_key' = ${input.idempotencyKey}`,
          ),
        )
        .orderBy(desc(job_events.id))
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        const sameInput =
          payloadString(existing.payload, 'operation_kind') === input.operationKind &&
          payloadString(existing.payload, 'input_hash') === input.inputHash;
        return {
          outcome: sameInput ? 'reused' : 'conflict',
          operationId: existing.businessId,
        };
      }
    }

    await writeJobEvent(tx, {
      business_table: INGESTION_OPERATION_TABLE,
      business_id: input.operationId,
      event_type: 'operation.accepted',
      payload: {
        session_id: input.sessionId,
        operation_kind: input.operationKind,
        input_hash: input.inputHash,
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      },
    });
    return { outcome: 'created', operationId: input.operationId };
  });
}

export async function writeIngestionOperationEvent(
  db: Db,
  input: {
    operationId: string;
    eventType:
      | 'operation.queued'
      | 'operation.running'
      | 'operation.completed'
      | 'operation.failed';
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await writeJobEvent(tx, {
      business_table: INGESTION_OPERATION_TABLE,
      business_id: input.operationId,
      event_type: input.eventType,
      payload: input.payload ?? {},
    });
  });
}

export async function hasQueuedIngestionOperationEvent(
  db: Db,
  operationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: job_events.id })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, INGESTION_OPERATION_TABLE),
        eq(job_events.business_id, operationId),
        eq(job_events.event_type, 'operation.queued'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** 串行化 accepted→pg-boss→queued 缝隙上的首次投递与崩溃恢复。 */
export async function withIngestionOperationDispatchLock<T>(
  db: Db,
  operationId: string,
  run: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'ingestion-operation-dispatch'}), hashtext(${operationId}))`,
    );
    return run();
  });
}

/** 从 append-only job_events 投影可轮询的 operation 资源。 */
export async function readIngestionOperation(
  db: Db,
  operationId: string,
): Promise<IngestionOperationResource | null> {
  const events = await db
    .select({
      eventType: job_events.event_type,
      payload: job_events.payload,
      occurredAt: job_events.occurred_at,
    })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, INGESTION_OPERATION_TABLE),
        eq(job_events.business_id, operationId),
      ),
    )
    .orderBy(asc(job_events.id));

  const accepted = events.find((event) => event.eventType === 'operation.accepted');
  if (!accepted) return null;

  const sessionId = payloadString(accepted.payload, 'session_id');
  const operationKind = payloadString(accepted.payload, 'operation_kind') as
    | IngestionOperationKind
    | undefined;
  if (!sessionId || !operationKind) return null;

  const last = events.at(-1) ?? accepted;
  const queued = [...events].reverse().find((event) => event.eventType === 'operation.queued');
  const terminal = [...events]
    .reverse()
    .find(
      (event) =>
        event.eventType === 'operation.completed' || event.eventType === 'operation.failed',
    );
  const completed = terminal?.eventType === 'operation.completed' ? terminal : undefined;
  const failed = terminal?.eventType === 'operation.failed' ? terminal : undefined;

  let status: IngestionOperationStatus = events.some(
    (event) => event.eventType === 'operation.running',
  )
    ? 'running'
    : 'queued';
  let updatedAt = last.occurredAt;

  if (completed) status = 'succeeded';
  else if (failed) status = 'failed';
  else if (
    operationKind === 'extract' &&
    events.some(
      (event) => event.eventType === 'operation.queued' || event.eventType === 'operation.running',
    )
  ) {
    const sessionRows = await db
      .select({ status: learning_session.status, updatedAt: learning_session.updated_at })
      .from(learning_session)
      .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
      .limit(1);
    const session = sessionRows[0];
    if (session) {
      updatedAt = session.updatedAt > updatedAt ? session.updatedAt : updatedAt;
      if (['extracted', 'partial', 'reviewed', 'imported'].includes(session.status)) {
        status = 'succeeded';
      } else if (session.status === 'failed') {
        status = 'failed';
      } else if (session.status === 'extracting') {
        status = 'running';
      }
    }
  }

  const errorPayload = failed?.payload.error;
  const error =
    errorPayload && typeof errorPayload === 'object'
      ? (errorPayload as unknown as IngestionOperationError)
      : operationKind === 'extract' && status === 'failed'
        ? { code: 'extraction_failed', message: 'Extraction failed', status: 500 }
        : undefined;

  return {
    id: operationId,
    kind: 'ingestion_operation',
    operation_kind: operationKind,
    status,
    session_id: sessionId,
    ...(payloadString(queued?.payload ?? {}, 'job_id')
      ? { job_id: payloadString(queued?.payload ?? {}, 'job_id') }
      : {}),
    ...(completed ? { result: completed.payload.result } : {}),
    ...(error ? { error } : {}),
    created_at: accepted.occurredAt.toISOString(),
    updated_at: updatedAt.toISOString(),
    events_url: `/api/jobs/${INGESTION_OPERATION_TABLE}/${encodeURIComponent(operationId)}/events`,
  };
}

export function isTerminalIngestionOperation(resource: IngestionOperationResource): boolean {
  return resource.status === 'succeeded' || resource.status === 'failed';
}
