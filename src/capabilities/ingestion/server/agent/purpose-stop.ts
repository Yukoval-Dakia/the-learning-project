import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as Ingestion from '../session-lifecycle';
import { settleAgentRunBudget } from './budget';
import { readAgentBudget, writeAgentBudgetPath } from './budget-state';
import { persistAgentRunHistory } from './history';

/** Only the executor whose awaited task/tools have ended may acknowledge stop.
 * Financial resolution is delegated unchanged: unknown liabilities stay unknown.
 */
export async function confirmAgentPurposeStop(
  db: Db,
  sessionId: string,
  runRef: string,
  requireIdle = false,
) {
  return db.transaction(async (tx) => {
    const owner = (await readAgentBudget(tx, sessionId, true))?.execution_owner;
    if (!owner || owner.run_ref !== runRef || !owner.stop_request_id) return false;
    if (owner.stop_confirmed) return true;
    if (requireIdle && owner.segment_state !== 'idle') return false;
    await Ingestion.markExtractionFailed(
      tx,
      sessionId,
      'ingestion stopped after purpose withdrawal; external effects may be irreversible',
    );
    await settleAgentRunBudget(tx, {
      sessionId,
      operationId: owner.operation_id ?? undefined,
      terminal: 'failed',
      error: { code: 'purpose_withdrawn', external_effect: 'unknown_or_irreversible' },
    });
    await writeAgentBudgetPath(tx, sessionId, ['execution_owner'], {
      ...owner,
      state: 'closed',
      stop_confirmed: true,
    });
    await persistAgentRunHistory(tx, { sessionId, runState: 'failed', executionClosed: true });
    return true;
  });
}

/** Existing minute sweeper closes only durable unclaimed/paused executions.
 * A lost running executor or legacy missing evidence remains pending/unknown.
 */
export async function recoverAgentPurposeStops(db: Db) {
  const rows = await db.execute<{ id: string; run_ref: string }>(sql`
    SELECT id, agent_budget->'execution_owner'->>'run_ref' AS run_ref FROM learning_session
    WHERE type = 'ingestion' AND agent_budget->'execution_owner'->>'state' = 'active'
      AND agent_budget->'execution_owner' ? 'stop_request_id'
      AND agent_budget->'execution_owner'->>'segment_state' = 'idle'
    ORDER BY id LIMIT 25
  `);
  for (const row of rows) await confirmAgentPurposeStop(db, row.id, row.run_ref, true);
}
