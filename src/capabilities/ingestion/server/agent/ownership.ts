import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { ApiError } from '@/kernel/http';
import {
  documentUsageEpoch,
  readDocumentDerivationPolicy,
} from '@/kernel/read-models/usage-policy';
import { writeAgentRunSegment } from '../events/agent-progress';
import {
  type AgentExecutionOwner,
  budgetUnavailable,
  readAgentBudget,
  writeAgentBudgetPath,
} from './budget-state';

type DeliveryIdentity = {
  sessionId: string;
  trigger: 'start' | 'resume' | 'continue';
  operationId?: string;
  runRef?: string;
};

/** Called with grant + queued + transactional job INSERT in the same tx. */
export async function bindGrantedAgentExecution(tx: Tx, sessionId: string, operationId: string) {
  const budget = await readAgentBudget(tx, sessionId, true);
  const identity = budget?.operations?.[operationId];
  if (!budget?.grants[operationId] || !identity) budgetUnavailable('budget_read_unavailable');
  const [floor] = await tx.execute<{ id: number }>(
    sql`SELECT COALESCE(MAX(id), 0)::int AS id FROM job_events`,
  );
  await writeAgentBudgetPath(tx, sessionId, ['execution_owner'], {
    operation_id: operationId,
    run_ref: operationId,
    protocol: 'transactional-v1',
    state: 'active',
    event_floor: floor?.id ?? 0,
    usage_epoch: (await readExecutionUsage(tx, sessionId)).epoch,
    segment_state: 'idle',
  } satisfies AgentExecutionOwner);
  await writeAgentBudgetPath(tx, sessionId, ['operations', operationId], {
    ...identity,
    dispatch_state: 'enqueued',
  });
}

async function resolveOwner(tx: Tx, input: DeliveryIdentity): Promise<AgentExecutionOwner | null> {
  const budget = await readAgentBudget(tx, input.sessionId, true);
  const owner = budget?.execution_owner;
  if (owner) {
    if (owner.state !== 'active') return null;
    if (input.runRef !== undefined && input.runRef !== owner.run_ref) return null;
    if (input.operationId !== undefined && input.operationId !== owner.operation_id) return null;
    if (owner.protocol === 'transactional-v1') {
      // New starts carry the exact operation. New resumptions carry the bound
      // intent's run_ref too. Unidentified old jobs cannot borrow this owner.
      if (input.operationId !== owner.operation_id) return null;
      if (input.trigger !== 'start' && input.runRef !== owner.run_ref) return null;
    } else if (input.trigger === 'start' && owner.operation_id && !input.operationId) {
      return null;
    }
    if (owner.protocol === 'legacy' && owner.operation_id && !input.operationId && !input.runRef) {
      // An unidentified old resume could belong to an earlier grant. Only a
      // single historical grant proves that it names this frozen legacy run.
      const ids = Object.keys(budget?.grants ?? {});
      if (ids.length !== 1 || ids[0] !== owner.operation_id) return null;
    }
    return owner;
  }

  // Upgrade compatibility: bind the payload's actual old grant, never latest.
  // Unidentified legacy resumes are only provable with a single old grant.
  const grants = Object.entries(budget?.grants ?? {});
  const selected = input.operationId
    ? grants.find(([id]) => id === input.operationId)
    : input.trigger !== 'start' && grants.length === 1
      ? grants[0]
      : undefined;
  let legacy: AgentExecutionOwner;
  if (
    selected &&
    selected[1].state === 'in_flight' &&
    !['completed', 'failed'].includes(selected[1].op_status ?? '')
  ) {
    legacy = {
      operation_id: selected[0],
      run_ref: selected[0],
      protocol: 'legacy',
      state: 'active',
    };
  } else {
    if (input.operationId || grants.length || Object.keys(budget?.operations ?? {}).length)
      return null;
    const evidence = await tx.execute<{ agent: boolean }>(sql`
      SELECT COUNT(*) = 1 AND BOOL_AND(payload->>'lane' = 'agent') AS agent
      FROM job_events WHERE business_table = 'ingestion_session'
        AND business_id = ${input.sessionId} AND event_type = 'ingestion.queued'
    `);
    if (!evidence[0]?.agent) return null;
    legacy = { operation_id: null, run_ref: input.sessionId, protocol: 'legacy', state: 'active' };
  }
  if (input.runRef !== undefined && input.runRef !== legacy.run_ref) return null;
  await writeAgentBudgetPath(tx, input.sessionId, ['execution_owner'], legacy);
  return legacy;
}

/** Fence before ANY session transition or segment claim. No grant is invented. */
export async function enterAgentExecution(tx: Tx, input: DeliveryIdentity) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`ingestion-agent-run:${input.sessionId}`}))`,
  );
  const rows = await tx.execute<{ status: string; source_document_id: string | null }>(sql`
    SELECT status, source_document_id FROM learning_session
    WHERE id = ${input.sessionId} AND type = 'ingestion' FOR UPDATE
  `);
  const session = rows[0];
  if (!session) return null;
  const usage = await readExecutionUsage(tx, input.sessionId);
  if (usage.policy !== 'allow') return null;
  const owner = ['queued', 'extracting'].includes(session.status)
    ? await resolveOwner(tx, input)
    : null;
  if (!owner) {
    // Rejected delivery is not proof that every previously claimed executor is
    // closed. Preserve the original uncertainty, including absent job rows.
    if (input.operationId) {
      const budget = await readAgentBudget(tx, input.sessionId);
      if (!budget?.grants[input.operationId]) {
        await writeAgentBudgetPath(
          tx,
          input.sessionId,
          ['unproven_dispatches', input.operationId],
          {
            reason: 'unowned_delivery',
            observed_at: new Date().toISOString(),
          },
        );
      }
    }
    return null;
  }
  if (owner.stop_request_id || (owner.usage_epoch ?? 'legacy') !== usage.epoch) return null;
  return { ...session, owner };
}

/** Bind resume/continue to the creating run, in the marker's own transaction. */
export async function recordAgentExecutionIntent(
  tx: Tx,
  sessionId: string,
  trigger: 'resume' | 'continue',
): Promise<number> {
  const owner = await resolveOwner(tx, { sessionId, trigger });
  // A transactional owner is already fixed, but resolveOwner intentionally
  // requires wire payload identity. Here the caller is writing its local intent.
  const current = (await readAgentBudget(tx, sessionId, true))?.execution_owner;
  const bound = current?.state === 'active' ? current : owner;
  if (!bound) budgetUnavailable('budget_read_unavailable');
  await requireAgentExecutionOwner(tx, sessionId, bound.run_ref);
  const id = await writeAgentRunSegment(tx, sessionId, {
    segment: 0,
    trigger,
    outcome: trigger === 'resume' ? 'resume_requested' : 'continue_requested',
  });
  await writeAgentBudgetPath(tx, sessionId, ['execution_intents', String(id)], bound);
  return id;
}

/** Resolve the exact durable intent, not whichever run is current at send time. */
export async function agentIntentPayload(
  db: Db,
  sessionId: string,
  trigger: 'resume' | 'continue',
  id?: number,
) {
  return db.transaction(async (tx) => {
    const budget = await readAgentBudget(tx, sessionId, true);
    let owner = id === undefined ? undefined : budget?.execution_intents?.[String(id)];
    if (!owner) {
      if (budget?.execution_owner?.protocol === 'transactional-v1')
        budgetUnavailable('budget_read_unavailable');
      const evidence =
        id === undefined
          ? []
          : await tx.execute<{ id: number }>(sql`
        SELECT id FROM job_events WHERE id = ${id} AND business_table = 'ingestion_agent_run'
          AND business_id = ${sessionId} AND payload->>'outcome' = ${`${trigger}_requested`}
      `);
      if (!evidence.length) budgetUnavailable('budget_read_unavailable');
      owner = (await resolveOwner(tx, { sessionId, trigger })) ?? undefined;
    }
    if (owner?.state !== 'active') budgetUnavailable('budget_read_unavailable');
    await requireAgentExecutionOwner(tx, sessionId, owner.run_ref);
    const current = (await readAgentBudget(tx, sessionId))?.execution_owner;
    if (
      current?.state !== 'active' ||
      current.run_ref !== owner.run_ref ||
      current.operation_id !== owner.operation_id
    )
      budgetUnavailable('unsettled_cost');
    return {
      sessionId,
      trigger,
      runRef: owner.run_ref,
      ...(owner.operation_id ? { operationId: owner.operation_id } : {}),
    };
  });
}

export async function closeAgentExecution(tx: Tx, sessionId: string, operationId?: string) {
  const budget = await readAgentBudget(tx, sessionId, true);
  const owner = budget?.execution_owner;
  if (!owner || (operationId !== undefined && owner.operation_id !== operationId)) return;
  await writeAgentBudgetPath(tx, sessionId, ['execution_owner'], { ...owner, state: 'closed' });
  const identity = owner.operation_id ? budget?.operations?.[owner.operation_id] : undefined;
  if (identity && owner.operation_id)
    await writeAgentBudgetPath(tx, sessionId, ['operations', owner.operation_id], {
      ...identity,
      dispatch_state: 'closed',
    });
}

/** Every post-claim write must still belong to its frozen run. */
export async function requireAgentExecutionOwner(tx: Tx, sessionId: string, runRef: string) {
  const owner = (await readAgentBudget(tx, sessionId, true))?.execution_owner;
  if (owner?.state !== 'active' || owner.run_ref !== runRef) budgetUnavailable('unsettled_cost');
  const usage = await readExecutionUsage(tx, sessionId);
  if (
    owner.stop_request_id ||
    usage.policy !== 'allow' ||
    (owner.usage_epoch ?? 'legacy') !== usage.epoch
  )
    throw new ApiError(
      'purpose_restricted',
      'this ingestion execution no longer has purpose authorization',
      409,
    );
}

async function readExecutionUsage(tx: Tx, sessionId: string) {
  const [row] = await tx.execute<{ provenance: unknown }>(sql`
    SELECT d.provenance FROM learning_session s JOIN source_document d ON d.id = s.source_document_id
    WHERE s.id = ${sessionId} FOR SHARE OF d
  `);
  if (!row) throw new ApiError('purpose_source_unavailable', 'ingestion source unavailable', 409);
  return {
    policy: readDocumentDerivationPolicy(row.provenance),
    epoch: documentUsageEpoch(row.provenance),
  };
}

/** Cross-process cooperative stop. DB intent is authoritative; no second run registry. */
export function watchAgentPurpose(db: Db, sessionId: string, runRef: string) {
  const controller = new AbortController();
  let closed = false;
  let checking = false;
  const check = async () => {
    try {
      await db.transaction((tx) => requireAgentExecutionOwner(tx, sessionId, runRef));
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  const timer = setInterval(() => {
    if (closed || checking) return;
    checking = true;
    void check()
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  }, 1000);
  timer.unref();
  return {
    controller,
    check,
    close: () => {
      closed = true;
      clearInterval(timer);
    },
  };
}
