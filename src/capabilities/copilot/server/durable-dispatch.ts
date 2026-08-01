import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { job_events } from '@/db/schema';
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
        input_hash: input.inputHash,
        boss_job_id: bossJobId,
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      },
    });
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
