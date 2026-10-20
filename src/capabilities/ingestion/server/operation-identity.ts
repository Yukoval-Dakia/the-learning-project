import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import {
  type AgentBudgetGrant,
  type AgentOperationIdentity,
  budgetUnavailable,
  parseAgentBudget,
  persistGrant,
  readAgentBudget,
  writeAgentBudgetPath,
} from './agent/budget-state';
import type { IngestionOperationResource } from './operation-store';

// This owner holds *all* agent reservations, including denied requests. A
// reservation has no spending authority; only budget.grants grants that.
function keyDigest(key: string): string {
  return createHash('sha256')
    .update('the-learning-project/ingestion-operation-key/v1\0')
    .update(key)
    .digest('hex');
}

/** Called inside the collection's key lock, before looking at TTL events. */
export async function findDurableAgentKey(
  tx: Tx,
  input: { sessionId: string; idempotencyKey: string; inputHash: string },
): Promise<{ operationId: string; sameInput: boolean } | null> {
  // This collection-wide lookup also serves non-agent operations. Absence is
  // not a binding; the route and agent reservation still validate the session.
  const rows = await tx.execute<{ agent_budget: unknown }>(sql`
    SELECT agent_budget FROM learning_session
    WHERE id = ${input.sessionId} AND type = 'ingestion' LIMIT 1
  `);
  const budget = parseAgentBudget(rows[0]?.agent_budget);
  const digest = keyDigest(input.idempotencyKey);
  for (const [operationId, identity] of Object.entries(budget?.operations ?? {})) {
    if (identity.key_digest === digest) {
      return { operationId, sameInput: identity.input_digest === input.inputHash };
    }
  }
  for (const [operationId, grant] of Object.entries(budget?.grants ?? {})) {
    if (grant.key_digest === digest) {
      return { operationId, sameInput: grant.input_digest === input.inputHash };
    }
  }
  return null;
}

export async function persistAgentReservation(
  tx: Tx,
  input: {
    sessionId: string;
    operationId: string;
    inputHash: string;
    idempotencyKey?: string;
    resource?: IngestionOperationResource;
    restored?: boolean;
  },
): Promise<void> {
  const budget = await readAgentBudget(tx, input.sessionId, true);
  if (budget?.operations?.[input.operationId]) return;
  const now = new Date().toISOString();
  const resource = input.resource;
  await writeAgentBudgetPath(tx, input.sessionId, ['operations', input.operationId], {
    key_digest: input.idempotencyKey ? keyDigest(input.idempotencyKey) : null,
    input_digest: input.inputHash,
    status:
      resource?.status === 'succeeded'
        ? 'completed'
        : resource?.status === 'failed'
          ? 'failed'
          : resource?.status === 'running'
            ? 'running'
            : 'accepted',
    created_at: resource?.created_at ?? now,
    updated_at: resource?.updated_at ?? now,
    // Only a newly created reservation proves it has never entered enqueue.
    dispatch_state: input.restored ? 'unproven' : 'not_started',
    ...(resource?.error ? { error: { ...resource.error } } : {}),
    ...(resource?.result !== undefined ? { result: resource.result } : {}),
  } satisfies AgentOperationIdentity);
}

/** Unknown old bindings cannot be treated as proof that a new key is unused. */
export async function requireAgentKeyEvidence(tx: Tx, sessionId: string): Promise<void> {
  const budget = await readAgentBudget(tx, sessionId);
  if (Object.values(budget?.grants ?? {}).some((grant) => grant.key_digest === undefined)) {
    budgetUnavailable('budget_read_unavailable');
  }
}

function fromGrant(grant: AgentBudgetGrant): AgentOperationIdentity {
  return {
    key_digest: grant.key_digest ?? null,
    input_digest: grant.input_digest ?? '',
    status: grant.op_status ?? (grant.state === 'settled' ? 'failed' : 'accepted'),
    created_at: grant.granted_at,
    updated_at: grant.op_updated_at ?? grant.settled_at ?? grant.granted_at,
    ...(grant.op_error ? { error: grant.op_error } : {}),
    ...(grant.op_result !== undefined ? { result: grant.op_result } : {}),
  };
}

export async function readDurableAgentOperation(
  db: Db | Tx,
  operationId: string,
): Promise<IngestionOperationResource | null> {
  const rows = await db.execute<{ id: string; agent_budget: unknown }>(sql`
    SELECT id, agent_budget FROM learning_session WHERE type = 'ingestion'
      AND (agent_budget->'operations' ? ${operationId} OR agent_budget->'grants' ? ${operationId})
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  const budget = parseAgentBudget(row.agent_budget);
  const grant = budget?.grants[operationId];
  const identity = budget?.operations?.[operationId] ?? (grant ? fromGrant(grant) : undefined);
  if (!identity) return null;
  const status =
    identity.status === 'completed'
      ? 'succeeded'
      : identity.status === 'accepted'
        ? 'queued'
        : identity.status;
  return {
    id: operationId,
    kind: 'ingestion_operation',
    operation_kind: 'agent',
    status,
    session_id: row.id,
    ...(status === 'succeeded' ? { result: identity.result ?? {} } : {}),
    ...(status === 'failed'
      ? {
          error: identity.error ?? {
            code: 'operation_failed',
            message: 'Operation failed',
            status: 500,
          },
        }
      : {}),
    created_at: identity.created_at,
    updated_at: identity.updated_at,
    events_url: `/api/jobs/ingestion_operation/${encodeURIComponent(operationId)}/events`,
  };
}

/** Atomic with the event write. A TTL or a stale worker cannot undo a terminal. */
export async function updateDurableAgentOperation(
  tx: Tx,
  operationId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string; agent_budget: unknown }>(sql`
    SELECT id, agent_budget FROM learning_session WHERE type = 'ingestion'
      AND (agent_budget->'operations' ? ${operationId} OR agent_budget->'grants' ? ${operationId})
    FOR UPDATE
  `);
  const row = rows[0];
  if (!row) return true; // Non-agent operation keeps its existing event behavior.
  const budget = parseAgentBudget(row.agent_budget);
  const grant = budget?.grants[operationId];
  const identity = budget?.operations?.[operationId] ?? (grant ? fromGrant(grant) : undefined);
  if (!identity) budgetUnavailable('budget_read_unavailable');
  if (identity.status === 'completed' || identity.status === 'failed') return false;
  const status =
    eventType === 'operation.completed'
      ? 'completed'
      : eventType === 'operation.failed'
        ? 'failed'
        : eventType === 'operation.running'
          ? 'running'
          : identity.status;
  const next = {
    ...identity,
    status,
    updated_at: new Date().toISOString(),
    ...(status === 'completed' ? { result: payload.result ?? {} } : {}),
    ...(status === 'failed' ? { error: payload.error } : {}),
  };
  await writeAgentBudgetPath(tx, row.id, ['operations', operationId], next);
  if (grant) {
    await persistGrant(tx, row.id, operationId, {
      ...grant,
      op_status: status,
      op_updated_at: next.updated_at,
      ...(status === 'completed' ? { op_result: next.result } : {}),
      ...(status === 'failed' ? { op_error: next.error as AgentOperationIdentity['error'] } : {}),
    });
  }
  return true;
}
