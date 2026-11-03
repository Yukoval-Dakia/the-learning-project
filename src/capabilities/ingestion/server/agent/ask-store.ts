import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import {
  ASK_ANSWER_CLAIMED,
  ASK_CREATED,
  ASK_RESOLVED,
  AskCreatedPayload,
  type AskCreatedPayloadT,
  AskResolvedPayload,
  type AskResolvedPayloadT,
  INGESTION_ASK_TABLE,
} from './contract';

// Read-only projection of the per-ask job_events stream. A leaf: ledger and
// history read asks through here, so the ask lifecycle (asks.ts) may depend on
// history without a module cycle.
type AskEventRow = {
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: string | Date;
};

export interface AskState {
  readonly created: AskCreatedPayloadT;
  readonly claimed: { idempotency_key: string; fingerprint: string } | null;
  readonly resolved: AskResolvedPayloadT | null;
  /** ISO time of ask.created. */
  readonly created_at: string;
  /** ISO time of ask.resolved; null while unresolved. */
  readonly resolved_at: string | null;
}

async function readAskRows(db: Db | Tx, askId: string): Promise<AskEventRow[]> {
  const rows = await db.execute<AskEventRow>(sql`
    SELECT event_type, payload, occurred_at
    FROM job_events
    WHERE business_table = ${INGESTION_ASK_TABLE}
      AND business_id = ${askId}
    ORDER BY id ASC
  `);
  return rows;
}

export async function readAskState(db: Db | Tx, askId: string): Promise<AskState | null> {
  const rows = await readAskRows(db, askId);
  const createdRow = rows.find((row) => row.event_type === ASK_CREATED);
  if (!createdRow) return null;
  const claimedRow = rows.find((row) => row.event_type === ASK_ANSWER_CLAIMED);
  const resolvedRow = rows.find((row) => row.event_type === ASK_RESOLVED);
  return {
    created: AskCreatedPayload.parse(createdRow.payload),
    claimed:
      claimedRow != null
        ? {
            idempotency_key: String(claimedRow.payload.idempotency_key),
            fingerprint: String(claimedRow.payload.fingerprint),
          }
        : null,
    resolved: resolvedRow != null ? AskResolvedPayload.parse(resolvedRow.payload) : null,
    created_at: new Date(createdRow.occurred_at).toISOString(),
    resolved_at: resolvedRow != null ? new Date(resolvedRow.occurred_at).toISOString() : null,
  };
}

/** All asks created under a session (resolved or not), for the resume ledger. */
export interface SessionAskRow {
  readonly ask_id: string;
  readonly created: AskCreatedPayloadT;
  readonly resolved: AskResolvedPayloadT | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export async function readSessionAsks(
  db: Db | Tx,
  sessionId: string,
  afterEventId = 0,
): Promise<SessionAskRow[]> {
  const createdRows = await db.execute<{ business_id: string; payload: unknown }>(sql`
    SELECT business_id, payload
    FROM job_events
    WHERE business_table = ${INGESTION_ASK_TABLE}
      AND event_type = ${ASK_CREATED}
      AND payload ->> 'session_id' = ${sessionId}
      AND id > ${afterEventId}
    ORDER BY id ASC
  `);
  const out: SessionAskRow[] = [];
  for (const row of createdRows) {
    const state = await readAskState(db, row.business_id);
    if (state == null) continue;
    out.push({
      ask_id: row.business_id,
      created: state.created,
      resolved: state.resolved,
      created_at: state.created_at,
      resolved_at: state.resolved_at,
    });
  }
  return out;
}
