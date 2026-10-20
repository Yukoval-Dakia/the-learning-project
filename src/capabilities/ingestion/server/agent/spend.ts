import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { providerCostProjectedCte } from '@/kernel/read-models/provider-cost-projection';
import {
  AGENT_TASK_KIND,
  type HistoricalOcrIdentity,
  budgetUnavailable,
  loadAgentBudgetRows,
  parseAgentBudget,
  readAgentBudget,
  writeAgentBudgetPath,
} from './budget-state';

// Financial identity is append-only. Execution terminal, missing rows, TTL and
// a new week cannot prove a liability was never sent or has been paid for.
const BOUND_OPERATION_IDS_SQL = sql`
  SELECT a->>'operation_id' FROM learning_session s,
    jsonb_array_elements(COALESCE(s.agent_budget->'attributions', '[]'::jsonb)) a
  WHERE s.type = 'ingestion'
`;
const HISTORICAL_AGENT_ATTEMPTS_SQL = sql`
  SELECT h.key FROM learning_session s,
    jsonb_each(COALESCE(s.agent_budget->'historical_ocr', '{}'::jsonb)) h
  WHERE s.type = 'ingestion' AND h.value->>'ownership' = 'agent'
`;
const AGENT_PROJECTED_FILTER = sql`
  task_kind = ${AGENT_TASK_KIND} OR (source = 'provider_attempt' AND (
    operation_id IN (${BOUND_OPERATION_IDS_SQL}) OR ref IN (${HISTORICAL_AGENT_ATTEMPTS_SQL})
  ))
`;
const UNPRICED_SQL = sql`
  cost_basis IS NOT DISTINCT FROM 'unknown' OR cost IS NULL OR currency IS DISTINCT FROM 'USD'
`;

export async function readAgentWeekSpend(tx: Tx, from: Date, to: Date) {
  const rows = await tx.execute<{ used_usd: number; unresolved_records: number }>(sql`
    ${providerCostProjectedCte(from, to)}
    SELECT COALESCE(SUM(cost) FILTER (WHERE NOT (${UNPRICED_SQL})), 0)::float8 AS used_usd,
      COUNT(*) FILTER (WHERE ${UNPRICED_SQL})::int AS unresolved_records
    FROM projected WHERE ${AGENT_PROJECTED_FILTER}
  `);
  return {
    usedUsd: rows[0]?.used_usd ?? 0,
    unresolved: (rows[0]?.unresolved_records ?? 0) > 0,
    unresolvedRecords: rows[0]?.unresolved_records ?? 0,
  };
}

/**
 * Discover legacy OCR once and retain its identity on an existing ingestion
 * session. Only an exact tool run_ref -> attempt_id is attribution evidence.
 * All unbound GLM OCR is potentially relevant: absence of an old agent window
 * is not proof of independence (the old streams may already have been pruned).
 * This rejects agent starts, never independent OCR or its existing billing.
 * Called under the start budget lock; the denial transaction must commit it.
 */
export async function retainHistoricalOcrLiabilities(tx: Tx, hostSessionId: string): Promise<void> {
  const saved = new Map<string, { sessionId: string; identity: HistoricalOcrIdentity }>();
  for (const row of await loadAgentBudgetRows(tx)) {
    const budget = parseAgentBudget(row.agentBudget);
    for (const [id, identity] of Object.entries(budget?.historical_ocr ?? {})) {
      saved.set(id, { sessionId: row.id, identity });
    }
  }
  const candidates = await tx.execute<{
    attempt_id: string;
    operation_id: string;
    agent_logs: string[];
    independent_logs: string[];
  }>(sql`
    SELECT pa.attempt_id::text, pa.operation_id::text,
      ARRAY(SELECT l.id FROM tool_call_log l WHERE l.tool_name = 'glm_ocr'
        AND l.output_json->>'run_ref' = pa.attempt_id::text
        AND (l.task_kind = ${AGENT_TASK_KIND} OR l.task_kind LIKE 'ingestion_agent:%')) AS agent_logs,
      ARRAY(SELECT l.id FROM tool_call_log l WHERE l.tool_name = 'glm_ocr'
        AND l.output_json->>'run_ref' = pa.attempt_id::text
        AND l.task_kind <> ${AGENT_TASK_KIND} AND l.task_kind NOT LIKE 'ingestion_agent:%'
        AND btrim(l.task_kind) <> '') AS independent_logs
    FROM provider_attempt pa
    WHERE pa.provider = 'glm' AND pa.lane_id = 'glm.ocr-layout-parsing'
      AND pa.operation_kind = 'ocr_page_fetch'
      AND pa.operation_id::text NOT IN (${BOUND_OPERATION_IDS_SQL})
  `);
  const now = new Date().toISOString();
  for (const row of candidates) {
    const previous = saved.get(row.attempt_id);
    const agentLogs = [
      ...new Set([...(previous?.identity.agent_log_ids ?? []), ...row.agent_logs]),
    ].sort();
    const independentLogs = [
      ...new Set([...(previous?.identity.independent_log_ids ?? []), ...row.independent_logs]),
    ].sort();
    const conflict = agentLogs.length > 0 && independentLogs.length > 0;
    const ownership = conflict
      ? 'unproven'
      : agentLogs.length > 0
        ? 'agent'
        : independentLogs.length > 0
          ? 'independent'
          : (previous?.identity.ownership ?? 'unproven');
    const evidence = [
      ...new Set([
        ...(previous?.identity.evidence_log_ids ?? []),
        ...agentLogs,
        ...independentLogs,
      ]),
    ].sort();
    if (
      previous &&
      previous.identity.ownership === ownership &&
      previous.identity.agent_log_ids !== undefined &&
      JSON.stringify(previous.identity.evidence_log_ids) === JSON.stringify(evidence)
    )
      continue;
    await writeAgentBudgetPath(
      tx,
      previous?.sessionId ?? hostSessionId,
      ['historical_ocr', row.attempt_id],
      {
        operation_id: row.operation_id,
        ownership,
        evidence_log_ids: evidence,
        agent_log_ids: agentLogs,
        independent_log_ids: independentLogs,
        first_seen_at: previous?.identity.first_seen_at ?? now,
        updated_at: now,
      } satisfies HistoricalOcrIdentity,
    );
  }
  // Previously observed records absent from today's source stay in the envelope.
}

/** All-time financial state. Only the known weekly subtotal uses a week filter. */
export async function hasUnresolvedAgentSpend(tx: Tx) {
  const rows = await tx.execute<{
    open_task_runs: number;
    open_attempts: number;
    unresolved_records: number;
    unproven_history: number;
  }>(sql`
    ${providerCostProjectedCte(new Date(0))}, priced AS (
      SELECT * FROM projected WHERE NOT (${UNPRICED_SQL})
    ), bound AS (
      SELECT a FROM learning_session s,
        jsonb_array_elements(COALESCE(s.agent_budget->'attributions', '[]'::jsonb)) a
      WHERE s.type = 'ingestion'
    ), history AS (
      SELECT h.key AS attempt_id, h.value AS identity FROM learning_session s,
        jsonb_each(COALESCE(s.agent_budget->'historical_ocr', '{}'::jsonb)) h
      WHERE s.type = 'ingestion'
    )
    SELECT
      (SELECT COUNT(*)::int FROM ai_task_runs t WHERE t.task_kind = ${AGENT_TASK_KIND}
        AND (t.status = 'running' OR NOT EXISTS (
          SELECT 1 FROM priced p WHERE p.ref = t.id
        ))) +
      (SELECT COUNT(*)::int FROM learning_session s,
        jsonb_object_keys(COALESCE(s.agent_budget->'tasks', '{}'::jsonb)) AS task_identity(task_id)
        WHERE s.type = 'ingestion' AND NOT EXISTS (
          SELECT 1 FROM priced p WHERE p.ref = task_id
        )) AS open_task_runs,
      (SELECT COUNT(*)::int FROM bound WHERE
        a->>'attempt_id' IS NULL OR NOT EXISTS (
          SELECT 1 FROM priced p WHERE p.source = 'provider_attempt'
            AND p.ref = a->>'attempt_id' AND p.operation_id = a->>'operation_id'
        )) +
      (SELECT COUNT(*)::int FROM provider_attempt pa WHERE pa.operation_kind = ${AGENT_TASK_KIND}
        AND pa.finished_at IS NULL) +
      (SELECT COUNT(*)::int FROM history h WHERE h.identity->>'ownership' = 'agent'
        AND NOT EXISTS (SELECT 1 FROM priced p WHERE p.source = 'provider_attempt'
          AND p.ref = h.attempt_id AND p.operation_id = h.identity->>'operation_id')) AS open_attempts,
      (SELECT COUNT(*)::int FROM projected WHERE (${AGENT_PROJECTED_FILTER})
        AND (${UNPRICED_SQL})) AS unresolved_records,
      (SELECT COUNT(*)::int FROM history WHERE identity->>'ownership' = 'unproven') +
      (SELECT COUNT(*)::int FROM learning_session s,
        jsonb_each(COALESCE(s.agent_budget->'grants', '{}'::jsonb)) g
        WHERE s.type = 'ingestion' AND g.value->>'settle_reason' IN ('queue_vanished', 'dispatch_unproven')
          AND g.value->>'execution_closed_at' IS NULL) +
      (SELECT COUNT(*)::int FROM provider_attempt pa WHERE pa.provider = 'glm'
        AND pa.lane_id = 'glm.ocr-layout-parsing' AND pa.operation_kind = 'ocr_page_fetch'
        AND pa.operation_id::text NOT IN (${BOUND_OPERATION_IDS_SQL})
        AND NOT EXISTS (SELECT 1 FROM history h WHERE h.attempt_id = pa.attempt_id::text)
      ) AS unproven_history
  `);
  const row = rows[0];
  if (!row) budgetUnavailable('budget_read_unavailable');
  return {
    unsettled:
      row.open_task_runs + row.open_attempts + row.unresolved_records + row.unproven_history > 0,
    openTaskRuns: row.open_task_runs,
    openAttempts: row.open_attempts,
    unresolvedRecords: row.unresolved_records,
    unprovenHistory: row.unproven_history,
  };
}

/** Durable main-model identity before entering runTask, including DB failures. */
export async function retainAgentTaskLiability(db: Db, sessionId: string, taskRunId: string) {
  await db.transaction(async (tx) => {
    const budget = await readAgentBudget(tx, sessionId, true);
    if (budget?.tasks?.[taskRunId]) return;
    await writeAgentBudgetPath(tx, sessionId, ['tasks', taskRunId], {
      bound_at: new Date().toISOString(),
    });
  });
}

/**
 * The agent's own write-ahead liability survives off/observe untracked acquire.
 * beforeRequest binds the *exact* attempt at the actual request callback, even
 * when lifecycle persistence failed open. No row or any ordinary catch leaves
 * the liability pending. Resolution is derived only from canonical priced cost.
 */
export async function withAgentProviderLiability<T>(
  db: Db,
  input: { sessionId: string; operationId: string; taskRunId: string; tool: string },
  execute: (beforeRequest: (attemptId: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  const liabilityId = randomUUID();
  const index = await db.transaction(async (tx) => {
    const budget = await readAgentBudget(tx, input.sessionId, true);
    const attributions = budget?.attributions ?? [];
    if (attributions.some((a) => a.operation_id === input.operationId)) {
      // Same anchor already entered this paid boundary. Do not re-send an
      // unknown or untracked outcome; the existing tool fence remains intact.
      budgetUnavailable('unsettled_cost', { operation_id: input.operationId });
    }
    await writeAgentBudgetPath(
      tx,
      input.sessionId,
      ['attributions'],
      [
        ...attributions,
        {
          operation_id: input.operationId,
          task_run_id: input.taskRunId,
          tool: input.tool,
          bound_at: new Date().toISOString(),
          liability_id: liabilityId,
        },
      ],
    );
    return attributions.length;
  });
  return execute(async (attemptId) => {
    await db.transaction(async (tx) => {
      const budget = await readAgentBudget(tx, input.sessionId, true);
      const attribution = budget?.attributions?.[index];
      if (attribution?.liability_id !== liabilityId) budgetUnavailable('budget_read_unavailable');
      if (attribution.attempt_id && attribution.attempt_id !== attemptId) {
        budgetUnavailable('unsettled_cost');
      }
      await writeAgentBudgetPath(tx, input.sessionId, ['attributions', String(index)], {
        ...attribution,
        attempt_id: attemptId,
      });
    });
  });
}
