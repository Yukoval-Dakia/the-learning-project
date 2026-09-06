import { createHash } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event, job_events } from '@/db/schema';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
import { getStartedBoss } from '@/server/boss/client';
import { writeJobEvent } from '@/server/events/writer';
import { writeCopilotUserAsk } from './chat';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import { copilotRunTerminalSql } from './copilot-run-terminal-sql';

export const COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

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
}

export type ReserveCopilotDurableAcceptanceResult =
  | { outcome: 'created' | 'reused'; acceptance: CopilotDurableAcceptance }
  | { outcome: 'conflict'; acceptance: CopilotDurableAcceptance };

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
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
 * Atomically persist the conversation ask and QUEUED acceptance. An advisory
 * lock collapses concurrent requests using the same key without a migration.
 */
export async function reserveCopilotDurableAcceptance(
  db: Db,
  input: {
    sessionId: string;
    userMessage: string;
    inputHash: string;
    idempotencyKey?: string;
    queuedPayload: Record<string, unknown>;
    assertActive?: () => void;
  },
): Promise<ReserveCopilotDurableAcceptanceResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('copilot-session-queue'), hashtext(${input.sessionId}))`);
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
    const runId = await writeCopilotUserAsk(tx, {
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      now: new Date(),
      ...(deterministicRunId ? { eventId: deterministicRunId } : {}),
    });
    input.assertActive?.();
    const bossJobId = copilotBossJobId(runId);
    await writeJobEvent(tx, {
      business_table: COPILOT_RUN_TABLE,
      business_id: runId,
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: {
        ...input.queuedPayload,
        run_id: runId,
        input_hash: input.inputHash,
        boss_job_id: bossJobId,
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      },
    });
    // The first accepted turn is dispatched while acceptance is still open;
    // later turns remain QUEUED until terminal wake-up.
    await dispatchSessionHeadTx(tx, input.sessionId);
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

/**
 * Pick the oldest non-terminal accepted turn for a session.  The session lock
 * and the SQL ordering make this a single-winner operation; dispatch_seq stays
 * in SQL and is never converted through JavaScript.
 */
export async function readCopilotSessionHead(tx: Tx, sessionId: string): Promise<CopilotSessionHead | null> {
  const rows = await tx.execute(sql`
    SELECT q.business_id AS run_id, q.payload
    FROM job_events q
    JOIN event ask ON ask.id = q.business_id
    WHERE q.business_table = ${COPILOT_RUN_TABLE}
      AND q.event_type = ${COPILOT_RUN_EVENTS.QUEUED}
      AND (q.payload->>'session_id') = ${sessionId}
      AND ask.action = 'experimental:copilot_user_ask'
      AND NOT EXISTS (
        SELECT 1 FROM job_events t
        WHERE t.business_table = q.business_table AND t.business_id = q.business_id
          AND ${copilotRunTerminalSql(sql.raw('t.event_type'), sql.raw('t.payload'))}
      )
    ORDER BY ask.dispatch_seq ASC, ask.id ASC
    LIMIT 1
  `) as Array<{ run_id: string; payload: unknown }>;
  const row = rows[0];
  if (!row || row.payload === null || typeof row.payload !== 'object' || Array.isArray(row.payload)) return null;
  const payload = row.payload as Record<string, unknown>;
  const bossJobId = payload.boss_job_id;
  if (typeof bossJobId !== 'string') return null;
  return { runId: row.run_id, sessionId, bossJobId, payload };
}

async function dispatchSessionHeadTx(tx: Tx, sessionId: string): Promise<string | null> {
  const head = await readCopilotSessionHead(tx, sessionId);
  if (!head) return null;
  const existing = (await tx.execute(sql`SELECT 1 FROM job_events WHERE business_table=${COPILOT_RUN_TABLE} AND business_id=${head.runId} AND event_type='copilot_run.dispatched' LIMIT 1`)) as unknown[];
  if (existing.length > 0) return null;
  const job: Record<string, unknown> = { ...head.payload, run_id: head.runId, session_id: sessionId };
  delete job.input_hash; delete job.idempotency_key; delete job.pickup_deadline_ms; delete job.dispatch;
  const sent = await (await getStartedBoss()).send('copilot_run', job, { id: head.bossJobId, db: fromPgBossDrizzleTx(tx) });
  if (!sent) throw new Error(`copilot session head ${head.runId} was not dispatched`);
  await writeJobEvent(tx, { business_table: COPILOT_RUN_TABLE, business_id: head.runId, event_type: 'copilot_run.dispatched', payload: { boss_job_id: head.bossJobId, session_id: sessionId, protocol_version: 2, pickup_deadline_ms: Date.now() + 10_000 } });
  return head.runId;
}

/** Dispatch exactly the current session head, idempotently, in the acceptance transaction. */
export async function dispatchSessionHead(db: Db, sessionId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('copilot-session-queue'), hashtext(${sessionId}))`);
    return dispatchSessionHeadTx(tx, sessionId);
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
