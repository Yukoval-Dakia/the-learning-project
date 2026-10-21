import { sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { writeAgentRunSegment } from '../events/agent-progress';
import { type SessionAskRow, readSessionAsks } from './asks';
import { readAgentEventFloor } from './budget-state';
import {
  AGENT_ITEM_STATE,
  AGENT_PAID_ATTEMPT,
  AGENT_RUN_SEGMENT,
  AGENT_TERMINAL_REQUEST,
  AgentItemStatePayload,
  AgentPaidAttemptPayload,
  AgentRunSegmentPayload,
  AgentTerminalRequestPayload,
  INGESTION_AGENT_ITEM,
  INGESTION_AGENT_RUN_TABLE,
  INGESTION_AGENT_STAGE,
  IngestionAgentItemPayload,
  type IngestionAgentItemStatusT,
  IngestionAgentStagePayload,
  type IngestionAgentStageT,
} from './contract';

// Run ledger: rebuilds an agent run's durable state from job_events. Resume
// segments use it for context; the orchestrator uses it for waiting/continue/done.

const SESSION_TABLE = 'ingestion_session' as const;
const TERMINAL_ITEM_STATUSES: readonly IngestionAgentItemStatusT[] = [
  'admitted',
  'withheld',
  'failed',
];

export interface ItemLedgerEntry {
  readonly item_id: string;
  readonly question_no: string;
  readonly status: IngestionAgentItemStatusT;
  readonly page?: number;
  readonly preview_md?: string;
  readonly draft_ref?: string;
  readonly question_id?: string;
}

export interface AgentRunLedger {
  readonly stage: IngestionAgentStageT | null;
  readonly items: ItemLedgerEntry[];
  readonly asks: SessionAskRow[];
  readonly openAsks: SessionAskRow[];
  readonly resolvedAsks: SessionAskRow[];
  /** Latest emitted segment marker. */
  readonly lastSegment: { segment: number; outcome?: string; task_run_id?: string } | null;
  readonly doneEmitted: boolean;
  /** R2-6: model-declared run-stop request, first marker wins. */
  readonly terminalRequest: { code: string; reason?: string } | null;
}

type RawEventRow = {
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
};

export async function readAgentRunLedger(db: Db | Tx, sessionId: string): Promise<AgentRunLedger> {
  const floor = await readAgentEventFloor(db, sessionId);
  const sessionRows = await db.execute<RawEventRow>(sql`
    SELECT event_type, payload
    FROM job_events
    WHERE business_table = ${SESSION_TABLE}
      AND business_id = ${sessionId}
      AND id > ${floor}
      AND event_type IN (${INGESTION_AGENT_STAGE}, ${INGESTION_AGENT_ITEM})
    ORDER BY id ASC
  `);
  const runRows = await db.execute<RawEventRow>(sql`
    SELECT event_type, payload
    FROM job_events
    WHERE business_table = ${INGESTION_AGENT_RUN_TABLE}
      AND business_id = ${sessionId}
      AND id > ${floor}
      AND event_type IN (${AGENT_ITEM_STATE}, ${AGENT_RUN_SEGMENT}, ${AGENT_TERMINAL_REQUEST})
    ORDER BY id ASC
  `);

  let stage: IngestionAgentStageT | null = null;
  const items = new Map<string, ItemLedgerEntry>();
  for (const row of sessionRows) {
    if (row.event_type === INGESTION_AGENT_STAGE) {
      const parsed = IngestionAgentStagePayload.safeParse(row.payload);
      if (parsed.success) stage = parsed.data.stage;
      continue;
    }
    const parsed = IngestionAgentItemPayload.safeParse(row.payload);
    if (!parsed.success) continue;
    const p = parsed.data;
    const prev = items.get(p.item_id);
    items.set(p.item_id, {
      ...prev,
      item_id: p.item_id,
      question_no: p.question_no,
      status: p.status,
      ...(p.page !== undefined ? { page: p.page } : {}),
      ...(p.preview_md !== undefined ? { preview_md: p.preview_md } : {}),
    });
  }

  let lastSegment: AgentRunLedger['lastSegment'] = null;
  let terminalRequest: AgentRunLedger['terminalRequest'] = null;
  for (const row of runRows) {
    if (row.event_type === AGENT_TERMINAL_REQUEST) {
      const parsed = AgentTerminalRequestPayload.safeParse(row.payload);
      if (parsed.success && terminalRequest == null) {
        terminalRequest = {
          code: parsed.data.code,
          ...(parsed.data.reason != null ? { reason: parsed.data.reason } : {}),
        };
      }
      continue;
    }
    if (row.event_type === AGENT_ITEM_STATE) {
      const parsed = AgentItemStatePayload.safeParse(row.payload);
      if (!parsed.success) continue;
      const p = parsed.data;
      const prev = items.get(p.item_id);
      if (prev == null) continue;
      items.set(p.item_id, {
        ...prev,
        draft_ref: p.draft_ref ?? prev.draft_ref,
        question_id: p.question_id ?? prev.question_id,
      });
      continue;
    }
    const parsed = AgentRunSegmentPayload.safeParse(row.payload);
    if (!parsed.success) continue;
    lastSegment = {
      segment: parsed.data.segment,
      ...(parsed.data.outcome != null ? { outcome: parsed.data.outcome } : {}),
      ...(parsed.data.task_run_id != null ? { task_run_id: parsed.data.task_run_id } : {}),
    };
  }

  const asks = await readSessionAsks(db, sessionId, floor);
  return {
    stage,
    items: [...items.values()],
    asks,
    openAsks: asks.filter((ask) => ask.resolved == null),
    resolvedAsks: asks.filter((ask) => ask.resolved != null),
    lastSegment,
    doneEmitted: stage === 'done',
    terminalRequest,
  };
}

/** Cheap terminal-request read for the progress tool's post-request gate. */
export async function readTerminalRequest(
  db: Db | Tx,
  sessionId: string,
): Promise<{ code: string; reason?: string } | null> {
  const floor = await readAgentEventFloor(db, sessionId);
  const rows = await db.execute<{ payload: Record<string, unknown> }>(sql`
    SELECT payload FROM job_events
    WHERE business_table = ${INGESTION_AGENT_RUN_TABLE}
      AND business_id = ${sessionId}
      AND id > ${floor}
      AND event_type = ${AGENT_TERMINAL_REQUEST}
    ORDER BY id ASC LIMIT 1
  `);
  const parsed = rows[0] == null ? null : AgentTerminalRequestPayload.safeParse(rows[0].payload);
  return parsed?.success === true
    ? {
        code: parsed.data.code,
        ...(parsed.data.reason != null ? { reason: parsed.data.reason } : {}),
      }
    : null;
}

/**
 * Paid-attempt state per segment for stale-segment recovery (R2-5):
 * 'sent' means the model call was dispatched — its provider outcome may be
 * unknown — so an automatic re-pay is forbidden.
 */
export async function readPaidAttempts(
  db: Db | Tx,
  sessionId: string,
): Promise<Map<number, { sent: boolean; settled: boolean; taskRunId?: string }>> {
  const floor = await readAgentEventFloor(db, sessionId);
  const rows = await db.execute<{ payload: Record<string, unknown> }>(sql`
    SELECT payload FROM job_events
    WHERE business_table = ${INGESTION_AGENT_RUN_TABLE}
      AND business_id = ${sessionId}
      AND id > ${floor}
      AND event_type = ${AGENT_PAID_ATTEMPT}
    ORDER BY id ASC
  `);
  const attempts = new Map<number, { sent: boolean; settled: boolean; taskRunId?: string }>();
  for (const row of rows) {
    const parsed = AgentPaidAttemptPayload.safeParse(row.payload);
    if (!parsed.success) continue;
    const prev = attempts.get(parsed.data.segment) ?? { sent: false, settled: false };
    attempts.set(parsed.data.segment, {
      sent: prev.sent || parsed.data.phase === 'sent',
      settled: prev.settled || parsed.data.phase === 'settled',
      ...(parsed.data.task_run_id != null ? { taskRunId: parsed.data.task_run_id } : prev),
    });
  }
  return attempts;
}

// ---------- segment claim (P1-5 mutual exclusion) ----------

/**
 * A numbered segment is OPEN while its latest row is outcome:'running' — any
 * later same-segment row (waiting/done/failed/early_exit) closes it. 'running'
 * rows stay exclusive even past STALE_SEGMENT_MS. Only terminal recovery may
 * close them; elapsed time is never permission for another paid segment.
 */
export const STALE_SEGMENT_MS = 25 * 60_000;

export type SegmentClaim =
  | { readonly kind: 'busy' }
  | { readonly kind: 'settlement_pending'; readonly segment: number; readonly markerId: number }
  | { readonly kind: 'over_cap'; readonly segment: number; readonly ledger: AgentRunLedger }
  | { readonly kind: 'ok'; readonly segment: number; readonly ledger: AgentRunLedger };

/**
 * Durable per-session mutual exclusion: the advisory lock serializes segment
 * claims; a session can hold at most one open running segment — a
 * concurrent delivery exits 'busy' and is skipped, so the paid model loop can
 * never run twice for the same session.
 */
export async function claimRunSegment(
  tx: Tx,
  sessionId: string,
  trigger: 'start' | 'resume' | 'continue',
  maxSegments: number,
): Promise<SegmentClaim> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`ingestion-agent-run:${sessionId}`}))`,
  );
  const floor = await readAgentEventFloor(tx, sessionId);
  const rows = await tx.execute<{ id: number; payload: Record<string, unknown> }>(sql`
    SELECT id, payload
    FROM job_events
    WHERE business_table = ${INGESTION_AGENT_RUN_TABLE}
      AND business_id = ${sessionId}
      AND id > ${floor}
      AND event_type = ${AGENT_RUN_SEGMENT}
    ORDER BY id ASC
  `);
  const latestBySegment = new Map<number, { outcome: string | null; id: number }>();
  let maxSegment = 0;
  for (const row of rows) {
    const parsed = AgentRunSegmentPayload.safeParse(row.payload);
    if (!parsed.success || parsed.data.segment < 1) continue;
    maxSegment = Math.max(maxSegment, parsed.data.segment);
    latestBySegment.set(parsed.data.segment, {
      outcome: parsed.data.outcome ?? null,
      id: row.id,
    });
  }
  if ([...latestBySegment.values()].some((seg) => seg.outcome === 'running')) {
    return { kind: 'busy' };
  }
  const latest = latestBySegment.get(maxSegment);
  // Old paid catches could close failed before their terminal transaction.
  // Never interpret that half-terminal as permission for another model call.
  if (latest?.outcome === 'failed') {
    return { kind: 'settlement_pending', segment: maxSegment, markerId: latest.id };
  }

  const ledger = await readAgentRunLedger(tx, sessionId);
  const segment = maxSegment + 1;
  await writeAgentRunSegment(tx, sessionId, {
    segment,
    trigger,
    outcome: 'running',
  });
  // Even the free cap terminal needs a durable recovery marker if its closing
  // transaction rolls back and the queue exhausts delivery attempts.
  if (segment > maxSegments) return { kind: 'over_cap', segment, ledger };
  return { kind: 'ok', segment, ledger };
}

/** Latest emitted status for one item, or null when the item was never reported. */
export async function readLatestItemStatus(
  db: Db | Tx,
  sessionId: string,
  itemId: string,
): Promise<IngestionAgentItemStatusT | null> {
  const floor = await readAgentEventFloor(db, sessionId);
  const rows = await db.execute<{ payload: Record<string, unknown> }>(sql`
    SELECT payload
    FROM job_events
    WHERE business_table = ${SESSION_TABLE}
      AND business_id = ${sessionId}
      AND id > ${floor}
      AND event_type = ${INGESTION_AGENT_ITEM}
      AND payload ->> 'item_id' = ${itemId}
    ORDER BY id DESC
    LIMIT 1
  `);
  const row = rows[0];
  if (row == null) return null;
  const parsed = IngestionAgentItemPayload.safeParse(row.payload);
  return parsed.success ? parsed.data.status : null;
}

export function isTerminalItemStatus(status: IngestionAgentItemStatusT): boolean {
  return TERMINAL_ITEM_STATUSES.includes(status);
}

export function terminalItemCounts(items: readonly ItemLedgerEntry[]): {
  items_terminal: number;
  items_failed: number;
} {
  const terminal = items.filter((item) => isTerminalItemStatus(item.status));
  return {
    items_terminal: terminal.length,
    items_failed: terminal.filter((item) => item.status === 'failed').length,
  };
}
