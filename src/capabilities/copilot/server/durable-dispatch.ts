import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import type { ConnectionOptions, JobWithMetadata, SendOptions } from 'pg-boss';

import { PICKUP_TIMEOUT_MS } from '@/capabilities/copilot/durable-pickup';
import type { Db, Tx } from '@/db/client';
import { job_events } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { writeCopilotInputEvent } from './chat';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import { copilotRunTerminalSql } from './copilot-run-terminal-sql';

export const COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH = 200;
export const COPILOT_SESSION_QUEUE_PROTOCOL_VERSION = 2;

/** The exact worker input persisted while a later turn waits behind its session head. */
export interface CopilotAcceptedJobData {
  user_message: string;
  triggered_by: 'chat' | 'chip';
  chip_kind?: string;
  ambient?: {
    route: string;
    focused_entity?: { kind: string; id: string };
  };
  correction_target_turn_id?: string;
  skill_context?: {
    skill: 'teaching' | 'solve' | 'quiz';
    ref: { kind: string; id: string };
  };
}

export interface CopilotRunJobData extends CopilotAcceptedJobData {
  run_id: string;
  session_id: string;
}

export interface CopilotDispatchBoss {
  send(name: string, data?: object | null, options?: SendOptions): Promise<string | null>;
  getJobById(
    name: string,
    id: string,
    options?: ConnectionOptions,
  ): Promise<JobWithMetadata | null>;
}

export type CopilotBossTransactionAdapter = (tx: Tx) => NonNullable<ConnectionOptions['db']>;

export interface CopilotDurableAcceptance {
  runId: string;
  sessionId: string;
  inputHash: string;
  bossJobId: string;
}

export interface CopilotSessionHead {
  runId: string;
  sessionId: string;
  bossJobId: string;
  payload: Record<string, unknown>;
  jobData?: CopilotRunJobData;
  protocolVersion?: number;
}

export type ReserveCopilotDurableAcceptanceResult =
  | { outcome: 'created' | 'reused'; acceptance: CopilotDurableAcceptance }
  | { outcome: 'conflict'; acceptance: CopilotDurableAcceptance };

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function payloadRecord(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = payload[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsePersistedJobData(
  payload: Record<string, unknown>,
  runId: string,
  sessionId: string,
): CopilotRunJobData | undefined {
  const value = payloadRecord(payload, 'job_data');
  if (
    !value ||
    value.run_id !== runId ||
    value.session_id !== sessionId ||
    typeof value.user_message !== 'string' ||
    (value.triggered_by !== 'chat' && value.triggered_by !== 'chip')
  ) {
    return undefined;
  }
  return value as unknown as CopilotRunJobData;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    // Idempotency hashes must not depend on the process ICU/locale build.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

/** Bind an Idempotency-Key to the complete normalized Copilot execution input. */
export function hashCopilotDurableInput(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/** The key never appears in the public run handle; only its one-way digest does. */
export function copilotRunIdForIdempotencyKey(idempotencyKey: string): string {
  const digest = createHash('sha256').update(`copilot-chat:${idempotencyKey}`).digest('hex');
  return `copilot_user_ask_${digest}`;
}

/** pg-boss explicit ids are UUIDs. Derive one deterministically from the stable run handle. */
export function copilotBossJobId(runId: string): string {
  const bytes = createHash('sha256').update(`copilot-run-job:${runId}`).digest().subarray(0, 16);
  // RFC 4122 version/variant bits. This is a name-derived identifier, not a random UUID.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function readCopilotDurableAcceptanceByRunId(
  db: Db | Tx,
  runId: string,
): Promise<CopilotDurableAcceptance | null> {
  const rows = await db
    .select({ payload: job_events.payload })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, COPILOT_RUN_TABLE),
        eq(job_events.business_id, runId),
        eq(job_events.event_type, COPILOT_RUN_EVENTS.QUEUED),
      ),
    )
    .limit(1);
  const payload = rows[0]?.payload;
  if (!payload) return null;
  const sessionId = payloadString(payload, 'session_id');
  const inputHash = payloadString(payload, 'input_hash');
  const bossJobId = payloadString(payload, 'boss_job_id');
  if (!sessionId || !inputHash || !bossJobId) return null;
  return { runId, sessionId, inputHash, bossJobId };
}

export async function isCopilotSessionQueueRun(db: Db | Tx, runId: string): Promise<boolean> {
  const rows = await db
    .select({ payload: job_events.payload })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, COPILOT_RUN_TABLE),
        eq(job_events.business_id, runId),
        eq(job_events.event_type, COPILOT_RUN_EVENTS.QUEUED),
      ),
    )
    .limit(1);
  return rows[0]?.payload.protocol_version === COPILOT_SESSION_QUEUE_PROTOCOL_VERSION;
}

async function acquireCopilotIdempotencyLock(tx: Tx, idempotencyKey: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`copilot-chat:${idempotencyKey}`}, 0))`,
  );
}

/** Fast replay path used before backlog, rate-limit, or model-dispatch gates. */
export async function findCopilotDurableAcceptance(
  db: Db,
  idempotencyKey: string,
): Promise<CopilotDurableAcceptance | null> {
  return readCopilotDurableAcceptanceByRunId(db, copilotRunIdForIdempotencyKey(idempotencyKey));
}

/**
 * Resolve an unknown acceptance COMMIT result. Taking the exact same advisory
 * lock as reserve is load-bearing: a plain read could race ahead of a late
 * COMMIT and falsely conclude that no accepted turn exists.
 */
export async function reconcileCopilotDurableAcceptance(
  db: Db,
  idempotencyKey: string,
): Promise<CopilotDurableAcceptance | null> {
  return db.transaction(async (tx) => {
    await acquireCopilotIdempotencyLock(tx, idempotencyKey);
    return readCopilotDurableAcceptanceByRunId(tx, copilotRunIdForIdempotencyKey(idempotencyKey));
  });
}

/**
 * Atomically persist the conversation ask and QUEUED acceptance. For protocol
 * v2, the current session head's pg-boss job and DISPATCHED marker join that
 * transaction. Advisory locks serialize the session and collapse concurrent
 * requests using the same idempotency key without a migration.
 */
export async function reserveCopilotDurableAcceptance(
  db: Db,
  input: {
    sessionId: string;
    userMessage: string;
    inputHash: string;
    idempotencyKey?: string;
    queuedPayload: Record<string, unknown>;
    /** Present only for the session-queue protocol. Legacy test/data seeders may omit it. */
    jobData?: CopilotAcceptedJobData;
    assertActive?: () => void;
  },
  deps: {
    boss?: CopilotDispatchBoss;
    transactionDb?: CopilotBossTransactionAdapter;
    nowMs?: () => number;
  } = {},
): Promise<ReserveCopilotDurableAcceptanceResult> {
  // Resolve the queue client before opening the business transaction. Keeping
  // this runtime dependency at the route/worker composition edges also avoids
  // making the durable state owner know how pg-boss is bootstrapped.
  if (input.jobData && (!deps.boss || !deps.transactionDb)) {
    throw new Error('session-queue acceptance requires transaction-capable queue dependencies');
  }
  const boss = input.jobData ? deps.boss : undefined;
  const transactionDb = input.jobData ? deps.transactionDb : undefined;
  return db.transaction(async (tx) => {
    await acquireCopilotSessionQueueLock(tx, input.sessionId);
    const deterministicRunId = input.idempotencyKey
      ? copilotRunIdForIdempotencyKey(input.idempotencyKey)
      : undefined;
    if (input.idempotencyKey && deterministicRunId) {
      await acquireCopilotIdempotencyLock(tx, input.idempotencyKey);
      const existing = await readCopilotDurableAcceptanceByRunId(tx, deterministicRunId);
      if (existing) {
        return {
          outcome: existing.inputHash === input.inputHash ? 'reused' : 'conflict',
          acceptance: existing,
        };
      }
    }

    input.assertActive?.();
    const runId = await writeCopilotInputEvent(tx, {
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      triggeredBy: input.jobData?.triggered_by,
      chipKind: input.jobData?.chip_kind,
      now: new Date(),
      ...(deterministicRunId ? { eventId: deterministicRunId } : {}),
    });
    input.assertActive?.();
    const bossJobId = copilotBossJobId(runId);
    const persistedJobData: CopilotRunJobData | undefined = input.jobData
      ? { ...input.jobData, run_id: runId, session_id: input.sessionId }
      : undefined;
    await writeJobEvent(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: {
        ...input.queuedPayload,
        run_id: runId,
        input_hash: input.inputHash,
        boss_job_id: bossJobId,
        ...(persistedJobData
          ? {
              protocol_version: COPILOT_SESSION_QUEUE_PROTOCOL_VERSION,
              job_data: persistedJobData,
            }
          : {}),
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      },
    });
    if (boss && transactionDb) {
      // The session head's domain acceptance, physical pg-boss row and
      // DISPATCHED marker commit or roll back together. Later turns remain QUEUED.
      await dispatchSessionHeadTx(tx, input.sessionId, boss, transactionDb, deps.nowMs);
    }
    input.assertActive?.();
    return {
      outcome: 'created',
      acceptance: {
        runId,
        sessionId: input.sessionId,
        inputHash: input.inputHash,
        bossJobId,
      },
    };
  });
}

export async function hasTerminalCopilotRun(db: Db | Tx, runId: string): Promise<boolean> {
  const rows = await db
    .select({ id: job_events.id })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, COPILOT_RUN_TABLE),
        eq(job_events.business_id, runId),
        copilotRunTerminalSql(job_events.event_type, job_events.payload),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function acquireCopilotSessionQueueLock(tx: Tx, sessionId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${'copilot-session-queue'}), hashtext(${sessionId}))`,
  );
}

/**
 * Pick the oldest non-terminal accepted turn for a session.  The session lock
 * and the SQL ordering make this a single-winner operation; dispatch_seq stays
 * in SQL and is never converted through JavaScript.
 */
export async function readCopilotSessionHead(
  db: Db | Tx,
  sessionId: string,
): Promise<CopilotSessionHead | null> {
  const rows = (await db.execute(sql`
    SELECT q.business_id AS run_id, q.payload
    FROM job_events q
    JOIN event ask ON ask.id = q.business_id
    WHERE q.business_table = ${COPILOT_RUN_TABLE}
      AND q.event_type = ${COPILOT_RUN_EVENTS.QUEUED}
      AND (q.payload->>'session_id') = ${sessionId}
      AND ask.action IN ('experimental:copilot_user_ask', 'experimental:copilot_chip_trigger')
      AND NOT EXISTS (
        SELECT 1 FROM job_events t
        WHERE t.business_table = q.business_table AND t.business_id = q.business_id
          AND ${copilotRunTerminalSql(sql.raw('t.event_type'), sql.raw('t.payload'))}
      )
    ORDER BY ask.dispatch_seq ASC, ask.id ASC
    LIMIT 1
  `)) as unknown as Array<{ run_id: string; payload: unknown }>;
  const row = rows[0];
  if (
    !row ||
    row.payload === null ||
    typeof row.payload !== 'object' ||
    Array.isArray(row.payload)
  ) {
    return null;
  }
  const payload = row.payload as Record<string, unknown>;
  const bossJobId = payload.boss_job_id;
  if (typeof bossJobId !== 'string') return null;
  const protocolVersion = payload.protocol_version;
  const jobData = parsePersistedJobData(payload, row.run_id, sessionId);
  return {
    runId: row.run_id,
    sessionId,
    bossJobId,
    payload,
    ...(typeof protocolVersion === 'number' ? { protocolVersion } : {}),
    ...(jobData ? { jobData } : {}),
  };
}

export async function hasCopilotRunDispatched(db: Db | Tx, runId: string): Promise<boolean> {
  const rows = await db
    .select({ id: job_events.id })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, COPILOT_RUN_TABLE),
        eq(job_events.business_id, runId),
        eq(job_events.event_type, COPILOT_RUN_EVENTS.DISPATCHED),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function dispatchSessionHeadTx(
  tx: Tx,
  sessionId: string,
  boss: CopilotDispatchBoss,
  transactionDb: CopilotBossTransactionAdapter,
  nowMs: (() => number) | undefined,
): Promise<string | null> {
  const head = await readCopilotSessionHead(tx, sessionId);
  if (!head) return null;
  if (await hasCopilotRunDispatched(tx, head.runId)) return null;
  // A legacy accepted run has no replayable job body. It remains ahead of v2
  // turns and follows the old dispatch/reconcile path instead of being guessed.
  if (
    head.protocolVersion !== COPILOT_SESSION_QUEUE_PROTOCOL_VERSION ||
    head.jobData === undefined
  ) {
    return null;
  }

  const adapter = transactionDb(tx);
  const sent = await boss.send('copilot_run', head.jobData, {
    id: head.bossJobId,
    db: adapter,
  });
  if (!sent) {
    // Stable-id insertion can return null if an older non-atomic producer
    // already committed the exact job. Adopt it only when its identity matches.
    const existing = await boss.getJobById('copilot_run', head.bossJobId, {
      db: adapter,
    });
    const existingData = existing?.data as Partial<CopilotRunJobData> | undefined;
    if (existingData?.run_id !== head.runId || existingData.session_id !== sessionId) {
      throw new Error(`copilot session head ${head.runId} was not dispatched`);
    }
  }
  await writeJobEvent(tx, {
    business_table: COPILOT_RUN_TABLE,
    business_id: head.runId,
    event_type: COPILOT_RUN_EVENTS.DISPATCHED,
    payload: {
      boss_job_id: head.bossJobId,
      session_id: sessionId,
      protocol_version: COPILOT_SESSION_QUEUE_PROTOCOL_VERSION,
      pickup_deadline_ms: (nowMs?.() ?? Date.now()) + PICKUP_TIMEOUT_MS,
    },
  });
  return head.runId;
}

/** Dispatch exactly the current session head; concurrent callers have one DB-linearized winner. */
export async function dispatchSessionHead(
  db: Db,
  sessionId: string,
  deps: {
    boss: CopilotDispatchBoss;
    transactionDb: CopilotBossTransactionAdapter;
    nowMs?: () => number;
  },
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await acquireCopilotSessionQueueLock(tx, sessionId);
    const head = await readCopilotSessionHead(tx, sessionId);
    if (
      !head ||
      head.protocolVersion !== COPILOT_SESSION_QUEUE_PROTOCOL_VERSION ||
      head.jobData === undefined ||
      (await hasCopilotRunDispatched(tx, head.runId))
    ) {
      return null;
    }
    return dispatchSessionHeadTx(tx, sessionId, deps.boss, deps.transactionDb, deps.nowMs);
  });
}

/** Serialize accepted→pg-boss dispatch and any definitive-failure compensation. */
export async function withCopilotDurableDispatchLock<T>(
  db: Db,
  runId: string,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'copilot-run-dispatch'}), hashtext(${runId}))`,
    );
    return run(tx);
  });
}
