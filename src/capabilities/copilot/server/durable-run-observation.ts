import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';

import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import { copilotRunTerminalSql } from './copilot-run-terminal-sql';
import { nativeSubagentProjectionCondition } from './subagent-mailbox';

export interface OutstandingCopilotDurableRun {
  runId: string;
  queuedAt: Date;
  sessionId?: string;
  triggeredBy?: 'chat' | 'chip';
  bossJobId?: string;
  pickupDeadlineMs?: number;
  protocolVersion?: number;
  dispatched: boolean;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read accepted runs with unfinished execution or an unfinished native child projection.
 *
 * Terminal filtering happens before LIMIT. Otherwise a retained prefix of
 * already-settled rows would make every sweep miss a later stranded run. A
 * terminal parent stays eligible only until its native child projections settle.
 * Duplicate QUEUED frames collapse to the first acceptance row.
 */
export async function findOutstandingCopilotDurableRuns(
  db: Db,
  limit: number,
): Promise<OutstandingCopilotDurableRun[]> {
  const terminalPredicate = copilotRunTerminalSql(
    sql.raw('terminal.event_type'),
    sql.raw('terminal.payload'),
  );
  const rows = (await db.execute(sql<{
    business_id: string;
    occurred_at: Date;
    payload: unknown;
    dispatched_payload: unknown;
  }>`
    SELECT queued.business_id, queued.occurred_at, queued.payload,
      (
        SELECT dispatched.payload
        FROM job_events dispatched
        WHERE dispatched.business_table = queued.business_table
          AND dispatched.business_id = queued.business_id
          AND dispatched.event_type = ${COPILOT_RUN_EVENTS.DISPATCHED}
        ORDER BY dispatched.id DESC
        LIMIT 1
      ) AS dispatched_payload
    FROM job_events queued
    WHERE queued.business_table = ${COPILOT_RUN_TABLE}
      AND queued.event_type = ${COPILOT_RUN_EVENTS.QUEUED}
      AND queued.id = (
        SELECT min(first_queued.id)
        FROM job_events first_queued
        WHERE first_queued.business_table = queued.business_table
          AND first_queued.business_id = queued.business_id
          AND first_queued.event_type = ${COPILOT_RUN_EVENTS.QUEUED}
      )
      AND (NOT EXISTS (
        SELECT 1
        FROM job_events terminal
        WHERE terminal.business_table = queued.business_table
          AND terminal.business_id = queued.business_id
          AND ${terminalPredicate}
      ) OR EXISTS (
        SELECT 1 FROM subagent_run
        WHERE subagent_run.parent_turn_event_id = queued.business_id
          AND subagent_run.session_id = queued.payload->>'session_id'
          AND subagent_run.status = 'running'
          AND ${nativeSubagentProjectionCondition()}
      ))
    ORDER BY queued.occurred_at ASC, queued.id ASC
    LIMIT ${limit}
  `)) as Array<{
    business_id: string;
    occurred_at: Date;
    payload: unknown;
    dispatched_payload: unknown;
  }>;

  return rows.map((row) => {
    const payload = payloadRecord(row.payload);
    const dispatchedPayload = payloadRecord(row.dispatched_payload);
    const jobData = payloadRecord(payload.job_data);
    const triggeredBy = jobData.triggered_by ?? payload.triggered_by;
    const protocolVersion = payload.protocol_version;
    const pickupDeadline =
      typeof dispatchedPayload.pickup_deadline_ms === 'number'
        ? dispatchedPayload.pickup_deadline_ms
        : protocolVersion === 2
          ? undefined
          : payload.pickup_deadline_ms;
    return {
      runId: row.business_id,
      queuedAt: row.occurred_at,
      ...(typeof payload.session_id === 'string' ? { sessionId: payload.session_id } : {}),
      ...(triggeredBy === 'chat' || triggeredBy === 'chip' ? { triggeredBy } : {}),
      ...(typeof payload.boss_job_id === 'string' ? { bossJobId: payload.boss_job_id } : {}),
      ...(typeof pickupDeadline === 'number' && Number.isFinite(pickupDeadline)
        ? { pickupDeadlineMs: pickupDeadline }
        : {}),
      ...(typeof protocolVersion === 'number' ? { protocolVersion } : {}),
      dispatched: row.dispatched_payload !== null,
    };
  });
}
